require('dotenv').config();
const express = require('express');
const { MessagingResponse } = require('twilio').twiml;
const { Groq } = require("groq-sdk");
const gTTS = require('gtts');
const fs = require('fs');
const util = require('util');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.static('public'));

// Initialize GROQ client
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY
});

// Webhook endpoint for WhatsApp messages.
app.post('/whatsapp', async (req, res) => {
  const incomingMsg = req.body.Body || '';
  
  try {
    // Use GROQ to get mythology information
    const completion = await groq.chat.completions.create({
      messages: [
        {
          role: "system",
          content: "You are an expert in Indian mythology. Provide detailed, engaging explanations of mythological stories, maintaining authenticity and cultural context."
        },
        {
          role: "user",
          content: `Tell me about the following Indian mythology topic: ${incomingMsg}. Break it down into chapters if applicable.`
        }
      ],
      model: "mixtral-8x7b-32768",
      temperature: 0.7,
      max_tokens: 2048,
      top_p: 1,
    });

    const mythologyContent = completion.choices[0].message.content;
    
    // Create audio file using gTTS
    const filename = `audio_${Date.now()}.mp3`;
    const outputPath = `public/${filename}`;
    
    // Initialize gTTS with the text and language
    const gtts = new gTTS(mythologyContent, 'en-in');
    
    // Save the audio file (returns a Promise)
    await new Promise((resolve, reject) => {
      gtts.save(outputPath, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    
    // Construct the public URL for the audio file
    const audioUrl = `${req.protocol}://${req.get('host')}/${filename}`;
    
    // Create Twilio MessagingResponse with both text and audio
    const twiml = new MessagingResponse();
    twiml.message(mythologyContent); // Send the text first
    const mediaMessage = twiml.message(); // Create a new message for the audio
    mediaMessage.media(audioUrl);
    
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(twiml.toString());
  } catch (error) {
    console.error('Error processing request:', error);
    res.status(500).send('Something went wrong');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`WhatsApp bot running on port ${PORT}`);
});
