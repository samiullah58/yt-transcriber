// api/transcript-simple.js
// YouTube Transcript Service using youtube-transcript

import { YoutubeTranscript } from 'youtube-transcript';

// CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

async function getTranscriptFromYouTube(videoId, lang = 'en') {
  console.log(`📥 Fetching transcript for: ${videoId}`);
  
  try {
    // Try to get transcript in the specified language
    let transcript = await YoutubeTranscript.fetchTranscript(videoId, {
      lang: lang,
      country: 'US'
    });
    
    console.log(`✅ Found transcript in ${lang}`);
    return transcript;
    
  } catch (error) {
    console.log(`⚠️ Failed to get transcript in ${lang}: ${error.message}`);
    
    // Try to get transcript in any available language
    try {
      console.log(`🔄 Trying to get transcript in any available language...`);
      const transcript = await YoutubeTranscript.fetchTranscript(videoId);
      console.log(`✅ Found transcript in available language`);
      return transcript;
      
    } catch (fallbackError) {
      console.log(`❌ No transcript available in any language: ${fallbackError.message}`);
      throw new Error(`No transcript available for this video. Error: ${fallbackError.message}`);
    }
  }
}

function formatTranscriptAsText(transcript) {
  return transcript.map(item => item.text).join(' ');
}

function formatTranscriptAsSrt(transcript) {
  return transcript.map((item, index) => {
    const startTime = formatTime(item.offset);
    const endTime = formatTime(item.offset + item.duration);
    return `${index + 1}\n${startTime} --> ${endTime}\n${item.text}\n`;
  }).join('\n');
}

function formatTime(milliseconds) {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const ms = milliseconds % 1000;
  
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')},${ms.toString().padStart(3, '0')}`;
}

// Main API handler
export default async function handler(req, res) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.status(200).end();
    return;
  }

  // Only allow POST requests
  if (req.method !== 'POST') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(405).json({ 
      error: 'Method not allowed. Use POST.' 
    });
    return;
  }

  try {
    console.log('🚀 YouTube Transcript Service (Simple) called');
    
    // Parse request body
    const { videoId, format = 'txt', lang = 'en' } = req.body;
    
    // Validate required parameters
    if (!videoId) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.status(400).json({ 
        error: 'Missing required parameter: videoId' 
      });
      return;
    }
    
    console.log(`🎬 Processing video: ${videoId}`);
    console.log(`📝 Format: ${format}`);
    console.log(`🌍 Language: ${lang}`);
    
    // Get transcript from YouTube
    const transcript = await getTranscriptFromYouTube(videoId, lang);
    
    if (!transcript || transcript.length === 0) {
      throw new Error('No transcript data received');
    }
    
    console.log(`✅ Transcript fetched successfully`);
    console.log(`📊 Transcript segments: ${transcript.length}`);
    console.log(`📝 Total characters: ${transcript.reduce((sum, item) => sum + item.text.length, 0)}`);
    
    // Format the output
    let output;
    let contentType;
    let filename;
    
    if (format.toLowerCase() === 'srt') {
      output = formatTranscriptAsSrt(transcript);
      contentType = 'text/plain; charset=utf-8';
      filename = `${videoId}.srt`;
    } else {
      output = formatTranscriptAsText(transcript);
      contentType = 'text/plain; charset=utf-8';
      filename = `${videoId}.txt`;
    }
    
    console.log('✅ Transcript formatting completed');
    
    // Return success response
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Transcript-Source', 'youtube-direct');
    res.status(200).json({
      success: true,
      data: {
        transcript: output,
        format: format.toLowerCase(),
        language: lang,
        segments: transcript.length,
        source: 'youtube-direct',
        videoId: videoId
      },
      message: 'Transcript extracted successfully from YouTube'
    });
    
  } catch (error) {
    console.error('❌ Service error:', error.message);
    
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Transcript extraction failed',
      hint: 'This video may not have captions available or they may be disabled.'
    });
  }
}
