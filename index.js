import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3000;

const ALLOWED_ORIGINS = [
  'https://www.jdpartners.co',
  'https://jdpartners.co',
  'http://localhost:3000',
  'http://127.0.0.1:5500',
];

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  },
}));
app.use(express.json());

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are a helpful AI assistant on the JD Partners website.
JD Partners is a Hong Kong-based private investment firm focused on private credit,
growth equity, real estate, and venture capital.
Answer questions clearly and concisely. For investment enquiries, suggest users
contact the team via the Contact page.`;

app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/chat', async (req, res) => {
  const { message, history = [] } = req.body;

  if (!message?.trim()) return res.status(400).json({ error: 'message required' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    const messages = [
      ...history.slice(-10),
      { role: 'user', content: message.trim() },
    ];

    const stream = client.messages.stream({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages,
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        res.write(`data: ${JSON.stringify({ text: event.delta.text })}\n\n`);
      }
    }
  } catch (err) {
    console.error('Anthropic error:', err.message);
    res.write(`data: ${JSON.stringify({ error: 'Something went wrong. Please try again.' })}\n\n`);
  }

  res.write('data: [DONE]\n\n');
  res.end();
});

app.listen(PORT, () => console.log(`Chatbot API on port ${PORT}`));
