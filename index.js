import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { GoogleGenerativeAI } from '@google/generative-ai';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3000;

const ALLOWED_ORIGINS = [
  'https://www.jdpartners.co',
  'https://jdpartners.co',
  'http://localhost:3000',
  'http://127.0.0.1:5500',
  'null', // local file:// opens
];

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  },
}));
app.use(express.json());

// ── Clients (skip gracefully if key missing) ──────────────────────────────
const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

const openaiClient = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

const grokClient = process.env.XAI_API_KEY
  ? new OpenAI({ apiKey: process.env.XAI_API_KEY, baseURL: 'https://api.x.ai/v1' }) : null;

const deepseekClient = process.env.DEEPSEEK_API_KEY
  ? new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: 'https://api.deepseek.com/v1' }) : null;

const geminiClient = process.env.GOOGLE_API_KEY
  ? new GoogleGenerativeAI(process.env.GOOGLE_API_KEY) : null;

// ── System prompt ─────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a helpful AI assistant. Answer questions clearly and concisely.
Keep responses focused and well-structured. Use plain text without markdown symbols.`;

// ── SSE helper ────────────────────────────────────────────────────────────
function send(res, provider, payload) {
  res.write(`data: ${JSON.stringify({ provider, ...payload })}\n\n`);
}

// ── Provider stream functions ─────────────────────────────────────────────
async function streamClaude(message, res) {
  if (!anthropic) {
    send(res, 'claude', { error: 'ANTHROPIC_API_KEY not set' });
    send(res, 'claude', { done: true });
    return;
  }
  try {
    const stream = anthropic.messages.stream({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: message }],
    });
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        send(res, 'claude', { text: event.delta.text });
      }
    }
  } catch (err) {
    send(res, 'claude', { error: err.message });
  }
  send(res, 'claude', { done: true });
}

async function streamOpenAICompat(client, model, provider, message, res) {
  if (!client) {
    send(res, provider, { error: `${provider.toUpperCase()}_API_KEY not set` });
    send(res, provider, { done: true });
    return;
  }
  try {
    const stream = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: message },
      ],
      stream: true,
      max_tokens: 1024,
    });
    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content || '';
      if (text) send(res, provider, { text });
    }
  } catch (err) {
    send(res, provider, { error: err.message });
  }
  send(res, provider, { done: true });
}

async function streamGemini(message, res) {
  if (!geminiClient) {
    send(res, 'gemini', { error: 'GOOGLE_API_KEY not set' });
    send(res, 'gemini', { done: true });
    return;
  }
  try {
    const model = geminiClient.getGenerativeModel({
      model: 'gemini-2.0-flash',
      systemInstruction: SYSTEM_PROMPT,
    });
    const result = await model.generateContentStream(message);
    for await (const chunk of result.stream) {
      const text = chunk.text();
      if (text) send(res, 'gemini', { text });
    }
  } catch (err) {
    send(res, 'gemini', { error: err.message });
  }
  send(res, 'gemini', { done: true });
}

// ── Routes ────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/chat', async (req, res) => {
  const { message } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'message required' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const msg = message.trim();

  await Promise.allSettled([
    streamClaude(msg, res),
    streamOpenAICompat(openaiClient,  'gpt-4o',         'chatgpt',  msg, res),
    streamOpenAICompat(grokClient,    'grok-3',          'grok',     msg, res),
    streamOpenAICompat(deepseekClient,'deepseek-chat',   'deepseek', msg, res),
    streamGemini(msg, res),
  ]);

  res.write('data: [ALL_DONE]\n\n');
  res.end();
});

app.listen(PORT, () => console.log(`Multi-AI API listening on port ${PORT}`));
