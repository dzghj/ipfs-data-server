import { Router } from "express";
import { auth } from "../auth.js";

const router = Router();

// Shared OpenAI call helper
async function openai({ systemPrompt, userContent }) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userContent  },
      ],
    }),
  });

  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || "OpenAI request failed");
  return data.choices[0].message.content;
}

// POST /api/ai/chat
router.post("/chat", auth, async (req, res, next) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: "Message is required" });

    const reply = await openai({
      systemPrompt: "You are ShadowVault AI assistant. You help users with digital vault security, legal documents, risk analysis, and audit logs.",
      userContent: message,
    });

    res.json({ success: true, response: reply });
  } catch (err) {
    next(err);
  }
});

// POST /api/ai/risk-analysis
router.post("/risk-analysis", auth, async (req, res, next) => {
  try {
    const analysis = await openai({
      systemPrompt: "You are a cybersecurity and digital vault risk analysis expert.",
      userContent: `Analyze vault security risk. Return Risk Score (0-100), Risk Level, Issues Found, and Recommendations.\n\nVault Data:\n${JSON.stringify(req.body, null, 2)}`,
    });

    res.json({ success: true, analysis });
  } catch (err) {
    next(err);
  }
});

// POST /api/ai/audit-analysis
router.post("/audit-analysis", auth, async (req, res, next) => {
  try {
    const { logs } = req.body;
    if (!logs) return res.status(400).json({ error: "Logs required" });

    const analysis = await openai({
      systemPrompt: "You are a cybersecurity audit log monitoring system.",
      userContent: `Analyze audit logs for suspicious activity, unusual logins, security risks. Return Risk Level, Suspicious Events, Explanation, and Recommended Actions.\n\nAudit Logs:\n${JSON.stringify(logs, null, 2)}`,
    });

    res.json({ success: true, analysis });
  } catch (err) {
    next(err);
  }
});

export default router;
