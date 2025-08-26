// api/transcript-captions.js
// YouTube Transcript Service using youtube-caption-extractor

import { getSubtitles, getVideoDetails } from 'youtube-caption-extractor';

// CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

async function getTranscriptFromYouTube(videoId, lang = 'en') {
  console.log(`📥 Fetching transcript for: ${videoId}`);
  
  try {
    // Get subtitles using youtube-caption-extractor
    const subtitles = await getSubtitles({ videoID: videoId, lang });
    console.log(`✅ Found ${subtitles.length} subtitle segments`);
    
    // Get video details for additional info
    const videoDetails = await getVideoDetails({ videoID: videoId, lang });
    console.log(`📺 Video title: ${videoDetails.title || 'Unknown'}`);
    
    return {
      subtitles,
      videoDetails,
      transcript: formatTranscriptAsText(subtitles)
    };
    
  } catch (error) {
    console.error(`❌ Failed to fetch transcript: ${error.message}`);
    throw new Error(`Failed to fetch transcript: ${error.message}`);
  }
}

function formatTranscriptAsText(subtitles) {
  // Combine all subtitle text into one continuous transcript
  return subtitles.map(item => item.text).join(' ');
}

function formatTranscriptAsSrt(subtitles) {
  return subtitles.map((item, index) => {
    const startTime = formatTime(parseFloat(item.start) * 1000);
    const endTime = formatTime((parseFloat(item.start) + parseFloat(item.dur)) * 1000);
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
    console.log('🚀 YouTube Caption Extractor Service called');
    
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
    const result = await getTranscriptFromYouTube(videoId, lang);
    
    if (!result.subtitles || result.subtitles.length === 0) {
      throw new Error('No transcript data received');
    }
    
    console.log(`✅ Transcript fetched successfully`);
    console.log(`📊 Transcript segments: ${result.subtitles.length}`);
    console.log(`📝 Total characters: ${result.transcript.length}`);
    
    // Format the output
    let output;
    let contentType;
    let filename;
    
    if (format.toLowerCase() === 'srt') {
      output = formatTranscriptAsSrt(result.subtitles);
      contentType = 'text/plain; charset=utf-8';
      filename = `${videoId}.srt`;
    } else {
      output = result.transcript;
      contentType = 'text/plain; charset=utf-8';
      filename = `${videoId}.txt`;
    }
    
    console.log('✅ Transcript formatting completed');
    
    // Return success response
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Transcript-Source', 'youtube-caption-extractor');
    res.status(200).json({
      success: true,
      data: {
        transcript: output,
        format: format.toLowerCase(),
        language: lang,
        segments: result.subtitles.length,
        source: 'youtube-caption-extractor',
        videoId: videoId,
        videoTitle: result.videoDetails?.title || 'Unknown',
        videoDuration: result.videoDetails?.duration || 'Unknown'
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
