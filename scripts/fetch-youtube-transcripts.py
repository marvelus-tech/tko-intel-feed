#!/usr/bin/env python3
"""Fetch YouTube transcripts for TKO episodes."""

import sys
import json
import re
from youtube_transcript_api import YouTubeTranscriptApi

def extract_video_id(url_or_id):
    """Extract YouTube video ID from URL or return ID."""
    if len(url_or_id) == 11 and re.match(r'^[a-zA-Z0-9_-]{11}$', url_or_id):
        return url_or_id
    
    # Extract from various YouTube URL formats
    patterns = [
        r'(?:youtube\.com/watch\?v=|youtu\.be/|youtube\.com/embed/)([a-zA-Z0-9_-]{11})',
        r'youtube\.com/shorts/([a-zA-Z0-9_-]{11})',
    ]
    
    for pattern in patterns:
        match = re.search(pattern, url_or_id)
        if match:
            return match.group(1)
    
    return None

def fetch_transcript(video_id):
    """Fetch transcript for a YouTube video."""
    ytt_api = YouTubeTranscriptApi()
    try:
        transcript = ytt_api.fetch(video_id)
        full_text = ' '.join([t.text for t in transcript])
        return {
            'success': True,
            'video_id': video_id,
            'transcript': full_text,
            'segment_count': len(transcript),
            'char_count': len(full_text)
        }
    except Exception as e:
        return {
            'success': False,
            'video_id': video_id,
            'error': str(e)
        }

def main():
    if len(sys.argv) < 2:
        print("Usage: python3 fetch-youtube-transcripts.py <video_id_or_url>")
        print("Example: python3 fetch-youtube-transcripts.py trdHxY1UMF0")
        sys.exit(1)
    
    video_input = sys.argv[1]
    video_id = extract_video_id(video_input)
    
    if not video_id:
        print(f"Error: Could not extract video ID from '{video_input}'")
        sys.exit(1)
    
    result = fetch_transcript(video_id)
    print(json.dumps(result, indent=2))

if __name__ == '__main__':
    main()
