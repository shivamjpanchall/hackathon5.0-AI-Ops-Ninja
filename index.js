const { ManagedIdentityCredential } = require("@azure/identity");
const { LogsQueryClient } = require("@azure/monitor-query");
const QuickChart = require("quickchart-js");
const axios = require("axios");
const FormData = require("form-data");

// ── ENV VARS ──────────────────────────────────────────────────────────────────
const JIRA_BASE_URL = process.env.JIRA_BASE_URL || process.env["JIRA-BASE-URL"];
const JIRA_USER_EMAIL =
  process.env.JIRA_USER_EMAIL || process.env["JIRA-USER-EMAIL"];
const JIRA_API_TOKEN =
  process.env.JIRA_API_TOKEN || process.env["JIRA-API-TOKEN"];
const PHI_ENDPOINT = process.env.PHI_ENDPOINT;
const PHI_KEY = process.env.PHI_KEY;
const LOG_ANALYTICS_WORKSPACE_ID =
  process.env.WORKSPACE_ID ||
  process.env.LOG_ANALYTICS_WORKSPACE_ID ||
  process.env["LOG-ANALYTICS-WORKSPACE-ID"];

// ── JIRA AUTH ─────────────────────────────────────────────────────────────────
function jiraAuthHeader() {
  const token = Buffer.from(`${JIRA_USER_EMAIL}:${JIRA_API_TOKEN}`).toString(
    "base64",
  );
  return `Basic ${token}`;
}

// ── POST COMMENT TO JIRA ──────────────────────────────────────────────────────
async function postJiraComment(issueKey, body) {
  await axios.post(
    `${JIRA_BASE_URL}/rest/api/2/issue/${issueKey}/comment`,
    { body },
    {
      headers: {
        Authorization: jiraAuthHeader(),
        "Content-Type": "application/json",
      },
    },
  );
}

// ── ATTACH FILE TO JIRA ───────────────────────────────────────────────────────
async function attachFileToJira(issueKey, imageBuffer, filename) {
  if (!Buffer.isBuffer(imageBuffer)) throw new Error("Invalid image buffer");
  const form = new FormData();
  form.append("file", imageBuffer, { filename, contentType: "image/png" });
  return axios.post(
    `${JIRA_BASE_URL}/rest/api/2/issue/${issueKey}/attachments`,
    form,
    {
      headers: {
        Authorization: jiraAuthHeader(),
        "X-Atlassian-Token": "no-check",
        ...form.getHeaders(),
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    },
  );
}

// ── SLEEP ─────────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── HEALTH CHECK ──────────────────────────────────────────────────────────────
async function checkSiteHealth(url) {
  const start = Date.now();
  try {
    const response = await axios.get(url, { timeout: 8000 });
    const latency = Date.now() - start;
    return {
      isUp: true,
      statusCode: response.status,
      latencyMs: latency,
      message:
        latency > 3000
          ? `Site is up and running fine. However, the performance is slower than expected, with a response time of ${latency}ms at the moment.`
          : `Site is up and healthy and performing as expected. The response time is ${latency}ms, and the HTTP status code returned is ${response.status})`,
    };
  } catch (error) {
    const latency = Date.now() - start;
    const statusCode = error.response ? error.response.status : null;
    return {
      isUp: false,
      statusCode,
      latencyMs: latency,
      message: statusCode
        ? `Site is currently down. The system returned an HTTP error ${statusCode} after ${latency}ms, indicating a failure in response`
        : `Site is currently unreachable. No response was received after ${latency}ms`,
    };
  }
}

// ── SCREENSHOT ────────────────────────────────────────────────────────────────
async function captureWebsiteScreenshot(url) {
  const cleanUrl = url.replace(/\/$/, "");
  const host = cleanUrl.replace(/https?:\/\//, "");
  const websiteUrl = `https://s.wordpress.com/mshots/v1/${encodeURIComponent(cleanUrl)}?w=1280`;
  //  const dnsUrl = `https://dns.google/resolve?name=${host}&type=A`;
  //  const dnsScreenshotUrl = `https://s.wordpress.com/mshots/v1/${encodeURIComponent(dnsUrl)}?w=1280`;
  const dnsUrl = `https://digwebinterface.com/?hostnames=${host}&type=&ns=resolver&useresolver=9.9.9.10&nameservers=`;
  const dnsScreenshotUrl = `https://s.wordpress.com/mshots/v1/${encodeURIComponent(dnsUrl)}?w=1280`;

  await sleep(3000);

  const [websiteRes, dnsRes] = await Promise.all([
    axios.get(websiteUrl, { responseType: "arraybuffer", timeout: 10000 }),
    axios.get(dnsScreenshotUrl, {
      responseType: "arraybuffer",
      timeout: 20000,
    }),
  ]);

  return {
    websiteScreenshot: Buffer.from(websiteRes.data),
    dnsScreenshot: Buffer.from(dnsRes.data),
  };
}

// ── QUERY LOG ANALYTICS ───────────────────────────────────────────────────────
async function queryLogs(url, context) {
  try {
    const credential = new ManagedIdentityCredential();
    const client = new LogsQueryClient(credential);
    const host = url
      .replace(/https?:\/\//, "")
      .replace(/\/$/, "")
      .split("/")[0];

    context.log("Querying logs for host: " + host);

    const query = `
      AppServiceHTTPLogs
      | where TimeGenerated > ago(1h)
      | where CsHost contains "${host}"
      | summarize
          TotalRequests = count(),
          Errors = countif(ScStatus >= 500),
          Warnings = countif(ScStatus >= 400 and ScStatus < 500),
          AvgLatency = avg(TimeTaken)
        by bin(TimeGenerated, 5m)
      | order by TimeGenerated desc
      | take 20
    `;

    const result = await client.queryWorkspace(
      LOG_ANALYTICS_WORKSPACE_ID,
      query,
      { duration: "PT1H" },
    );
    context.log("Log rows returned: " + (result.tables[0]?.rows?.length || 0));

    if (result.tables.length > 0 && result.tables[0].rows.length > 0) {
      const table = result.tables[0];
      return table.rows.map((row) => {
        const obj = {};
        table.columns.forEach((col, i) => {
          obj[col.name] = row[i];
        });
        return obj;
      });
    }
    return [];
  } catch (err) {
    context.log("Log Analytics failed: " + err.message);
    return [];
  }
}

// ── GENERATE CHART ────────────────────────────────────────────────────────────
async function generateCpuChart(logRows) {
  const labels = logRows.map((r) =>
    new Date(r.TimeGenerated).toLocaleTimeString("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
    }),
  );
  const errors = logRows.map((r) => r.Errors || 0);
  const warnings = logRows.map((r) => r.Warnings || 0);
  const latencies = logRows.map((r) => Math.round(r.AvgLatency || 0));

  const chart = new QuickChart();
  chart.setWidth(800);
  chart.setHeight(400);
  chart.setVersion("2");
  chart.setConfig(
    JSON.stringify({
      type: "bar",
      data: {
        labels,
        datasets: [
          {
            label: "Errors (5xx)",
            data: errors,
            backgroundColor: "rgba(220,53,69,0.7)",
            borderColor: "#dc3545",
            borderWidth: 1,
          },
          {
            label: "Warnings (4xx)",
            data: warnings,
            backgroundColor: "rgba(255,193,7,0.7)",
            borderColor: "#ffc107",
            borderWidth: 1,
          },
          {
            label: "Avg Latency (ms)",
            data: latencies,
            type: "line",
            borderColor: "#0d6efd",
            fill: false,
            yAxisID: "y2",
          },
        ],
      },
      options: {
        plugins: {
          title: { display: true, text: "Site Health - Last 1 Hour" },
        },
        scales: {
          y: { beginAtZero: true },
          y2: { beginAtZero: true, position: "right" },
        },
      },
    }),
  );
  return await chart.toBinary();
}

// ── SEARCH PAST TICKETS ───────────────────────────────────────────────────────
async function searchPastTickets(projectKey, contextData) {
  try {
    const url = contextData.url;

    const host = url ? url.replace(/https?:\/\//, "").split("/")[0] : null;

    const keywords = extractKeywords(contextData);
    const textQuery = keywords.slice(0, 3).join(" ");

    let jql = `
      project = ${projectKey}
      AND (
        summary ~ "${textQuery}"
        OR description ~ "${textQuery}"
      )
      ORDER BY created DESC
    `;

    console.log("JQL USED:", jql);

    let res = await axios.get(`${JIRA_BASE_URL}/rest/api/2/search`, {
      params: {
        jql,
        maxResults: 10,
        fields: "summary,resolution,status,created",
      },
      headers: { Authorization: jiraAuthHeader() },
    });

    let issues = res.data.issues || [];

    // 🔥 STRONG fallback using URL keyword (VERY IMPORTANT)
    if (issues.length === 0 && host) {
      console.log("Fallback: host-based search");

      const fallbackJql = `
        project = ${projectKey}
        AND summary ~ "${host}"
        ORDER BY created DESC
      `;

      const fallback = await axios.get(`${JIRA_BASE_URL}/rest/api/2/search`, {
        params: {
          jql: fallbackJql,
          maxResults: 10,
          fields: "summary,resolution,status,created",
        },
        headers: { Authorization: jiraAuthHeader() },
      });

      issues = fallback.data.issues || [];
    }

    return issues;
  } catch (e) {
    console.error("Past ticket search failed:", e.message);
    return [];
  }
}

// ── AI SUMMARY ────────────────────────────────────────────────────────────────
async function summariseWithAI(healthResult, logRows, org, url, pastTickets) {
  const logSummary =
    logRows.length > 0
      ? logRows
          .slice(0, 5)
          .map(
            (r) =>
              `Time: ${new Date(r.TimeGenerated).toLocaleTimeString()} | Errors: ${r.Errors} | Warnings: ${r.Warnings} | Avg Latency: ${Math.round(r.AvgLatency)}ms`,
          )
          .join("\n")
      : "No log data found for this site in the last hour.";

  const pastIncidentsSummary =
    pastTickets && pastTickets.length > 0
      ? pastTickets
          .map(
            (t) =>
              `- ${t.key}: ${t.fields.summary} [${t.fields.status?.name}] -> Resolution: ${t.fields.resolution?.name || "Unresolved"}`,
          )
          .join("\n")
      : "No similar past incidents found.";

  const prompt = `You are an incident response engineer at ${org}.
Site: ${url}
Health: ${healthResult.message}
Status Code: ${healthResult.statusCode || "N/A"}
Response Time: ${healthResult.latencyMs}ms

Azure Logs (last 1 hour):
${logSummary}

Similar past incidents:
${pastIncidentsSummary}

Write a professional incident comment with EXACTLY these 5 sections:

*CURRENT STATUS*
[2-3 sentences about site status]

*ERROR ANALYSIS*
[2-3 sentences about errors found]

*PERFORMANCE*
[2-3 sentences about response time and latency]

*LIKELY CAUSE*
[2-3 sentences about probable root cause]

*RECOMMENDATION*
[2-3 sentences about what engineer should do]

RULES:
- Use exactly the section headers above with asterisks
- Maximum 50 words per section
- Plain text only
- Do NOT include thinking tags or meta-commentary
- Start directly with *CURRENT STATUS*`;

  const response = await axios.post(
    PHI_ENDPOINT,
    {
      model: "Phi-4-reasoning",
      messages: [
        {
          role: "system",
          content:
            "You are an incident response engineer. Output ONLY the 5 sections. Never output thinking tags. Start with *CURRENT STATUS*.",
        },
        { role: "user", content: prompt },
      ],
      max_tokens: 800,
      temperature: 0.1,
    },
    {
      headers: {
        Authorization: `Bearer ${PHI_KEY}`,
        "Content-Type": "application/json",
      },
      timeout: 20000,
    },
  );

  let content = response.data.choices[0].message.content;
  content = content.replace(/<think>[\s\S]*?<\/think>/gi, "");
  content = content.replace(
    /^(okay|alright|now|let me|i need|i will|putting this|make sure|note that|first|next|finally).*$/gim,
    "",
  );
  content = content.replace(/\n{3,}/g, "\n\n").trim();
  return content;
}

// ── MAIN FUNCTION ─────────────────────────────────────────────────────────────
module.exports = async function (context, req) {
  context.log("Function triggered");

  try {
    const body = req.body;
    const issueKey = body?.issue?.key;
    const fields = body?.issue?.fields || {};
    const projectKey = body?.issue?.fields?.project?.key || "AON";

    // URL from customfield_10051
    const siteUrl =
      fields?.customfield_10051 ||
      extractUrl(fields?.description || "") ||
      extractUrl(fields?.summary || "");

    // Org from customfield_10052
    const org =
      fields?.customfield_10052 ||
      fields?.customfield_10002?.[0]?.name ||
      "Unknown Org";

    context.log(
      `Issue: ${issueKey} | URL: ${siteUrl} | Org: ${org} | Project: ${projectKey}`,
    );

    if (!issueKey || !siteUrl) {
      context.log("Missing issueKey or siteUrl");
      context.res = { status: 400, body: "Missing issueKey or site URL" };
      return;
    }

    // ── 1. Health check ───────────────────────────────────────────────────────
    const healthResult = await checkSiteHealth(siteUrl);
    context.log("Health: " + healthResult.message);

    // ── 2. Capture screenshots ────────────────────────────────────────────────
    let screenshots = null;
    try {
      screenshots = await Promise.race([
        captureWebsiteScreenshot(siteUrl),
        new Promise((resolve) => setTimeout(() => resolve(null), 12000)),
      ]);
      context.log(
        screenshots ? "Screenshots captured" : "Screenshots timed out",
      );
    } catch (e) {
      context.log("Screenshot error: " + e.message);
    }

    // ── 3. Upload screenshots to Jira FIRST ───────────────────────────────────
    let websiteAttachmentName = null;
    let dnsAttachmentName = null;

    if (screenshots?.websiteScreenshot) {
      await attachFileToJira(
        issueKey,
        screenshots.websiteScreenshot,
        "website.png",
      );
      websiteAttachmentName = "website.png";
      context.log("Website screenshot attached");
    }

    if (screenshots?.dnsScreenshot) {
      await attachFileToJira(issueKey, screenshots.dnsScreenshot, "dns.png");
      dnsAttachmentName = "dns.png";
      context.log("DNS screenshot attached");
    }

    // ── 4. Post FIRST comment with health + inline screenshots ────────────────
    const initialComment = `Hello Team, \n
      Greetings!!\n\n

      We have performed a check on the website and would like to confirm that the ${healthResult.message} \n\n We are currently analyzing the Azure logs to gather additional insights and are in the process of generating a detailed report. Further updates will be shared shortly.

*SITE STATUS*
${healthResult.message}

*Organisation:* ${org}
*URL:* ${siteUrl}

${websiteAttachmentName ? `*Website Screenshot:*\n!${websiteAttachmentName}|width=600!\n` : ""}${dnsAttachmentName ? `*DNS Screenshot:*\n!${dnsAttachmentName}|width=600!\n` : ""}
We are now analyzing Azure logs and generating a detailed AI report. A follow-up update will be posted shortly.`.trim();

    await postJiraComment(issueKey, initialComment);
    context.log("Initial comment posted successfully");

    // ── 5. Query logs ─────────────────────────────────────────────────────────
    const logRows = await queryLogs(siteUrl, context);
    context.log(`Log rows: ${logRows.length}`);

    // ── 6. Search past tickets ────────────────────────────────────────────────
    const pastTickets = await searchPastTickets(projectKey, {
      url: siteUrl,
      summary: fields?.summary,
      description: fields?.description,
    });
    context.log(`Past tickets: ${pastTickets.length}`);

    // ── 7. AI summary ─────────────────────────────────────────────────────────
    let aiSummary = "AI summary unavailable.";
    try {
      aiSummary = await Promise.race([
        summariseWithAI(healthResult, logRows, org, siteUrl, pastTickets),
        new Promise((resolve) =>
          setTimeout(
            () => resolve("AI summary timed out. Please check logs manually."),
            18000,
          ),
        ),
      ]);
      context.log("AI summary generated");
    } catch (e) {
      context.log("AI summary error: " + e.message);
    }

    // ── 8. Generate and attach chart ──────────────────────────────────────────
    let chartAttachmentName = null;
    if (logRows.length > 0) {
      try {
        const chartBuffer = await generateCpuChart(logRows);
        const chartFilename = `health-chart-${issueKey}.png`;
        await attachFileToJira(issueKey, chartBuffer, chartFilename);
        chartAttachmentName = chartFilename;
        context.log("Chart attached");
      } catch (e) {
        context.log("Chart error: " + e.message);
      }
    }

    // ── 9. Post SECOND comment with AI analysis ───────────────────────────────
    const finalComment = `Hello Team,\n
Greetings! \n\n
    Kindly find below the details generated from the initial Azure analysis conducted on ${new Date().toUTCString()}

*AI ANALYSIS*
${aiSummary}

*LOG SUMMARY (last 1 hour)*
${
  logRows.length > 0
    ? logRows
        .slice(0, 3)
        .map(
          (r) =>
            `* ${new Date(r.TimeGenerated).toLocaleTimeString()} - Errors: ${r.Errors}, Warnings: ${r.Warnings}, Avg Latency: ${Math.round(r.AvgLatency)}ms`,
        )
        .join("\n")
    : "No log data found for this site."
}

*SIMILAR PAST INCIDENTS*
${
  pastTickets.length > 0
    ? pastTickets
        .map(
          (t) => `* ${t.key}: ${t.fields.summary} [${t.fields.status?.name}]`,
        )
        .join("\n")
    : "No similar past incidents found."
}

${chartAttachmentName ? `*Health Chart:*\n!${chartAttachmentName}|width=700!` : ""}`.trim();

    await postJiraComment(issueKey, finalComment);
    context.log("Final comment posted successfully");

    context.res = { status: 200, body: `${issueKey} processed successfully` };
  } catch (err) {
    context.log.error("Function error: " + err.message);
    context.res = { status: 500, body: `Error: ${err.message}` };
  }
};

function extractUrl(text) {
  if (!text) return null;
  const match = text.match(/https?:\/\/[^\s]+/);
  return match ? match[0].replace(/[,.]$/, "") : null;
}
