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
  
  // Method 1: Try youtube-transcript with different configurations
  const methods = [
    {
      name: 'youtube-transcript with lang',
      fn: () => YoutubeTranscript.fetchTranscript(videoId, { lang, country: 'US' })
    },
    {
      name: 'youtube-transcript without lang',
      fn: () => YoutubeTranscript.fetchTranscript(videoId)
    },
    {
      name: 'youtube-transcript with different country',
      fn: () => YoutubeTranscript.fetchTranscript(videoId, { lang, country: 'GB' })
    }
  ];
  
  for (const method of methods) {
    try {
      console.log(`🔄 Trying ${method.name}...`);
      const transcript = await method.fn();
      console.log(`✅ Success with ${method.name}`);
      return transcript;
    } catch (error) {
      console.log(`⚠️ ${method.name} failed: ${error.message}`);
    }
  }
  
  // Method 2: Try to fetch captions directly from YouTube's API
  try {
    console.log(`🔄 Trying direct YouTube API method...`);
    const transcript = await fetchCaptionsDirectly(videoId, lang);
    console.log(`✅ Success with direct API method`);
    return transcript;
  } catch (error) {
    console.log(`⚠️ Direct API method failed: ${error.message}`);
  }
  
  // Method 3: Try to get available languages first
  try {
    console.log(`🔄 Trying to get available languages first...`);
    const languages = await YoutubeTranscript.listTranscripts(videoId);
    console.log(`📋 Available languages:`, languages.map(l => l.language));
    
    // Try each available language
    for (const language of languages) {
      try {
        console.log(`🔄 Trying language: ${language.language}`);
        const transcript = await language.fetch();
        console.log(`✅ Success with language: ${language.language}`);
        return transcript;
      } catch (error) {
        console.log(`⚠️ Language ${language.language} failed: ${error.message}`);
      }
    }
  } catch (error) {
    console.log(`⚠️ Language listing failed: ${error.message}`);
  }
  
  throw new Error(`All transcript methods failed for video ${videoId}`);
}

async function fetchCaptionsDirectly(videoId, lang = 'en') {
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
  
  // Fetch the video page
  const response = await fetch(videoUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Accept-Encoding': 'gzip, deflate',
      'DNT': '1',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
    }
  });
  
  if (!response.ok) {
    throw new Error(`Failed to fetch video page: ${response.status}`);
  }
  
  const html = await response.text();
  
  // Extract ytInitialPlayerResponse
  const ytInitialPlayerResponseMatch = html.match(/var ytInitialPlayerResponse = ({.+?});/);
  if (!ytInitialPlayerResponseMatch) {
    throw new Error('Could not find ytInitialPlayerResponse');
  }
  
  const playerResponse = JSON.parse(ytInitialPlayerResponseMatch[1]);
  const captions = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  
  if (!captions || captions.length === 0) {
    throw new Error('No captions found in player response');
  }
  
  console.log(`📋 Found ${captions.length} caption tracks`);
  
  // Find the best caption track
  let bestCaption = captions[0];
  for (const caption of captions) {
    if (caption.languageCode === lang) {
      bestCaption = caption;
      break;
    }
  }
  
  console.log(`🎯 Using caption track: ${bestCaption.languageCode} (${bestCaption.name?.simpleText || 'Unknown'})`);
  
  // Fetch the caption data
  const captionResponse = await fetch(bestCaption.baseUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    }
  });
  
  if (!captionResponse.ok) {
    throw new Error(`Failed to fetch captions: ${captionResponse.status}`);
  }
  
  const captionText = await captionResponse.text();
  
  // Parse the caption XML
  const transcript = parseCaptionXml(captionText);
  
  if (!transcript || transcript.length === 0) {
    throw new Error('Failed to parse caption data');
  }
  
  return transcript;
}

function parseCaptionXml(xmlText) {
  const transcript = [];
  
  // Simple XML parsing for caption data
  const textMatches = xmlText.match(/<text[^>]*dur="([^"]*)"[^>]*start="([^"]*)"[^>]*>([^<]*)<\/text>/g);
  
  if (!textMatches) {
    throw new Error('No caption text found in XML');
  }
  
  textMatches.forEach((match, index) => {
    const durMatch = match.match(/dur="([^"]*)"/);
    const startMatch = match.match(/start="([^"]*)"/);
    const textMatch = match.match(/>([^<]*)</);
    
    if (durMatch && startMatch && textMatch) {
      const start = parseFloat(startMatch[1]) * 1000; // Convert to milliseconds
      const duration = parseFloat(durMatch[1]) * 1000;
      const text = textMatch[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
      
      transcript.push({
        text: text,
        offset: start,
        duration: duration
      });
    }
  });
  
  return transcript;
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
      hint: 'This video may not have captions available or they may be disabled. Try using the audio transcription endpoint instead.'
    });
  }
}
