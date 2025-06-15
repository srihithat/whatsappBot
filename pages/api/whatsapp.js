import twilio from 'twilio';
import { Groq } from "groq-sdk";
import gTTS from 'gtts';
import path from 'path';
import fs from 'fs';

// Twilio REST client
const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const MessagingResponse = twilio.twiml.MessagingResponse;
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
  timeout: 30000 // 30 second timeout
});

// Parse raw body for URL-encoded data
const getRawBody = async (req) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
};

// Helper function to handle GROQ requests with timeout
const getGroqResponse = async (message) => {
  try {
    const completion = await Promise.race([
      groq.chat.completions.create({
        messages: [
          {
            role: "system",
            content: "You are an expert in Indian mythology. Provide brief, engaging explanations of mythological stories in 2-3 sentences. Focus on the most important aspects while maintaining authenticity."
          },
          {
            role: "user",
            content: `Tell me about this Indian mythology topic: ${message}`
          }
        ],
        model: "llama-3.3-70b-versatile",
        temperature: 0.7,
        max_tokens: 200,  // Shorter, more concise responses
        top_p: 1,
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('GROQ request timeout')), 25000)
      )
    ]);
    return completion.choices[0].message.content;
  } catch (error) {
    console.error('GROQ Error:', error);
    throw error;
  }
};

// Helper function to generate audio
const generateAudio = async (text) => {
  console.log('Starting audio generation process...');
  const filename = `audio_${Date.now()}.mp3`;
  const publicDir = path.join(process.cwd(), 'public');
  const outputPath = path.join(publicDir, filename);
  
  try {
    console.log('Public directory path:', publicDir);
    console.log('Output file path:', outputPath);
    
    // Make sure public directory exists
    if (!fs.existsSync(publicDir)) {
      console.log('Creating public directory...');
      fs.mkdirSync(publicDir, { recursive: true });
    }
    
    // Initialize gTTS with the text and language
    console.log('Initializing gTTS...');
    const gtts = new gTTS(text, 'en');
    
    // Save the audio file
    console.log('Saving audio file...');
    await new Promise((resolve, reject) => {
      gtts.save(outputPath, (err) => {
        if (err) {
          console.error('Error saving audio:', err);
          reject(err);
        } else {
          console.log('Audio file saved successfully at:', outputPath);
          console.log('File exists:', fs.existsSync(outputPath));
          resolve();
        }
      });
    });
    
    return { filename, success: true };
  } catch (error) {
    console.error('Error generating audio:', error);
    return { filename, success: false, error };
  }
};

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method === 'GET') return res.status(200).send('WhatsApp bot running');

  // parse incoming webhook
  const rawBody = await getRawBody(req);
  const params = new URLSearchParams(rawBody);
  const incomingMsg = params.get('Body') || '';
  const from = params.get('From');

  try {
    // get text from GROQ
    const mythologyContent = await getGroqResponse(incomingMsg);

    // generate audio
    const { filename, success } = await generateAudio(mythologyContent);
    const mediaUrl = success
      ? [`${process.env.BASE_URL}/${filename}`]
      : [];

    // send message via Twilio REST API
    await client.messages.create({
      from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
      to: from,
      body: mythologyContent,
      mediaUrl: mediaUrl
    });

    return res.status(200).end();
  } catch (e) {
    console.error('Error sending via REST API:', e);
    return res.status(500).end();
  }
}
