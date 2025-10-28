import json
import re
import sys
import os
from datetime import datetime, timedelta

# ----------------------
# Utilities
# ----------------------
def get_formatted_date(date_string):
    """
    Convert 'Today' or 'Yesterday' to actual dates, or parse explicit dates like
    '10 October 2025' and return 'DD Month, YYYY'. If parsing fails, return the original.
    """
    today = datetime.now()

    if isinstance(date_string, str) and re.search(r'\bToday\b', date_string, flags=re.IGNORECASE):
        return today.strftime("%d %B, %Y")
    if isinstance(date_string, str) and re.search(r'\bYesterday\b', date_string, flags=re.IGNORECASE):
        return (today - timedelta(days=1)).strftime("%d %B, %Y")

    s = date_string.strip()
    s = re.sub(r'(?i)^Activity on\s+', '', s).strip()

    # Find a DD Month YYYY substring if present
    m = re.search(r'(\d{1,2}\s+[A-Za-z]+\s+\d{4})', s)
    if not m:
        return date_string

    date_part = m.group(1)
    for fmt in ("%d %B %Y", "%d %b %Y", "%d %B, %Y", "%d %b, %Y"):
        try:
            dt = datetime.strptime(date_part, fmt)
            return dt.strftime("%d %B, %Y")
        except ValueError:
            continue

    return date_string


def normalize_time(time_str):
    """
    Normalize time strings like '10:01pm', '10:01 pm', '10:01 P.M.' to 'hh:mm am/pm'
    """
    if not time_str:
        return time_str
    t = time_str.lower().replace('.', '').strip()
    t = re.sub(r'(\d{1,2}:\d{2})\s*([ap]m)$', r'\1 \2', t)
    return t

# ----------------------
# Speaker / Device heuristics (no hardcoded speaker names)
# ----------------------
def split_speaker_and_device_from_info(info_line):
    """
    Given an info_line (which may contain speaker+device concatenated or just device),
    return (speaker, device) with rules:
      - If info_line contains a possessive ("'s"), treat entire info_line as device and speaker='undefined'
      - Else if a device keyword is present, take device = substring starting at the earliest keyword occurrence;
            speaker_candidate = substring before that (may be empty)
            if speaker_candidate exists, try to extract a plausible speaker name:
                - prefer first whitespace-separated token if it is a capitalized word
                - otherwise match a leading CamelCase/name token like 'SherwinBangalore' -> 'Sherwin'
      - Else if info_line has a space and the first token looks like a capitalized name, treat first token as speaker and rest as device
      - Otherwise treat entire info_line as device and speaker='undefined'
    No hardcoded speaker names are used.
    """
    if not info_line:
        return "undefined", ""

    info = info_line.strip()

    # If possessive anywhere, treat as device (common pattern 'Name's device ...')
    if re.search(r"[A-Za-z0-9_\-]+\s*'s\b", info) or "'s" in info:
        # Entire string is device; do not try to pull speaker automatically
        return "undefined", info

    # device keywords to detect probable device boundary (lowercased checks)
    device_keywords = ['echo', 'echoshow', 'fire tv', 'firetv', 'alexa', 'dot', 'tv', 'edition', 'fire', 'show']
    lower = info.lower()

    # find earliest occurrence of any keyword
    earliest_idx = None
    earliest_kw = None
    for kw in device_keywords:
        idx = lower.find(kw)
        if idx != -1:
            if earliest_idx is None or idx < earliest_idx:
                earliest_idx = idx
                earliest_kw = kw

    if earliest_idx is not None:
        # device is everything from earliest_idx to end
        device = info[earliest_idx:].strip()
        speaker_candidate = info[:earliest_idx].strip()

        # attempt to extract speaker from speaker_candidate
        if not speaker_candidate:
            return "undefined", device

        # If speaker_candidate contains whitespace, prefer the first token if it looks like a name
        first_token = speaker_candidate.split()[0]
        if re.match(r'^[A-Z][a-z]+$', first_token):
            return first_token, device

        # If concatenated (no spaces), try to extract a leading name via regex: leading capitalized sequence
        m = re.match(r'^([A-Z][a-z]+)', speaker_candidate)
        if m:
            return m.group(1), device

        # fallback: leave speaker undefined, keep device
        return "undefined", device

    # If no device keyword found:
    # If there's a space and the first token looks like a capitalized name and the rest is not empty -> split
    tokens = info.split()
    if len(tokens) >= 2 and re.match(r'^[A-Z][a-z]+$', tokens[0]):
        # consider first token as speaker, rest as device
        speaker = tokens[0]
        device = " ".join(tokens[1:]).strip()
        return speaker, device

    # fallback: entire info_line as device
    return "undefined", info

# ----------------------
# NEW: Parse structured transcript format
# ----------------------
def parse_structured_transcripts(file_path):
    """
    Parse the new structured format where each activity has explicit fields:
      --- Activity X ---
      Speaker: ...
      Device: ...
      Timestamp: ...
      Transcript: ...
    
    Returns list of dicts with activity_number, transcript, type, timestamp, speaker, device
    """
    detailed_transcripts = []

    with open(file_path, 'r', encoding='utf-8') as f:
        content = f.read()

    # Split by activity blocks
    activity_blocks = re.split(r'--- Activity (\d+) ---', content)
    
    # The first element is empty, then activity number, then block content, alternating
    for i in range(1, len(activity_blocks), 2):
        activity_num = int(activity_blocks[i])
        block_content = activity_blocks[i + 1].strip()
        
        # Parse the structured fields
        speaker = "Unknown"
        device = "Unknown" 
        timestamp = "Unknown"
        transcript = ""
        
        lines = [line.strip() for line in block_content.split('\n') if line.strip()]
        
        for line in lines:
            if line.startswith('Speaker:'):
                speaker = line.replace('Speaker:', '').strip()
            elif line.startswith('Device:'):
                device = line.replace('Device:', '').strip()
            elif line.startswith('Timestamp:'):
                timestamp = line.replace('Timestamp:', '').strip()
            elif line.startswith('Transcript:'):
                transcript = line.replace('Transcript:', '').strip()
        
        # Determine type based on transcript content
        transcript_type = "system"
        if transcript.startswith('"') and transcript.endswith('"'):
            transcript_type = "spoken"
            transcript = transcript[1:-1]  # Remove quotes for spoken content
        elif "[System activity - no spoken content]" in transcript:
            transcript_type = "system"
        
        entry = {
            "activity_number": activity_num,
            "transcript": transcript,
            "type": transcript_type,
            "timestamp": timestamp,
            "speaker": speaker,
            "device": device
        }
        
        detailed_transcripts.append(entry)
    
    return detailed_transcripts

# ----------------------
# Matching and duplicate logic
# ----------------------
def match_audio_with_transcripts(audio_urls, transcripts_data):
    """
    Match audio URLs with transcripts based on activity_number.
    Returns two lists: matched_audio_urls and matched_transcripts
    """
    # tolerate activity_number being string/int in either input
    audio_lookup = {int(a["activity_number"]): a["url"] for a in audio_urls}
    transcript_lookup = {int(t["activity_number"]): t for t in transcripts_data}

    common = set(audio_lookup.keys()) & set(transcript_lookup.keys())
    sorted_common = sorted(common)

    matched_audio_urls = []
    matched_transcripts = []

    print(f"🔍 Matching audio URLs with transcripts by activity number...")
    print(f"   - Audio URLs activities: {sorted(audio_lookup.keys())}")
    print(f"   - Transcript activities: {sorted(transcript_lookup.keys())}")
    print(f"   - Common activities: {sorted_common}")

    for act in sorted_common:
        matched_audio_urls.append(audio_lookup[act])
        t_copy = transcript_lookup[act].copy()
        if "activity_number" in t_copy:
            del t_copy["activity_number"]
        matched_transcripts.append(t_copy)

    return matched_audio_urls, matched_transcripts


def process_duplicates_with_logic(audio_urls, transcripts_data):
    """
    For consecutive duplicate audio URLs:
      - keep only transcripts of type "spoken"
      - if none are spoken, drop the group
    """
    filtered_audio_urls = []
    filtered_transcripts = []

    i = 0
    while i < len(audio_urls):
        cur_url = audio_urls[i]
        # find consecutive duplicates
        dup_indices = []
        j = i + 1
        while j < len(audio_urls) and audio_urls[j] == cur_url:
            dup_indices.append(j)
            j += 1

        if dup_indices:
            group_indices = [i] + dup_indices
            group_transcripts = [transcripts_data[k] for k in group_indices]
            spoken = [g for g in group_transcripts if g.get("type") == "spoken"]
            if spoken:
                # Keep all spoken entries for the same URL
                for s in spoken:
                    filtered_audio_urls.append(cur_url)
                    filtered_transcripts.append(s)
                print(f"🔊 Duplicate group {group_indices}: kept {len(spoken)} 'spoken', removed {len(group_transcripts)-len(spoken)} 'system'")
            else:
                print(f"🔊 Duplicate group {group_indices}: removed all {len(group_transcripts)} 'system' entries")
            i = j
        else:
            filtered_audio_urls.append(cur_url)
            filtered_transcripts.append(transcripts_data[i])
            i += 1

    return filtered_audio_urls, filtered_transcripts


def create_final_mapping(audio_urls, transcripts_data):
    """
    Create final mapping {audio_url: transcript_dict}
    """
    mapping = {}
    for u, t in zip(audio_urls, transcripts_data):
        mapping[u] = t
    return mapping

def cleanup_input_files(audio_urls_file, transcripts_file):
    """Clean up input files after successful processing"""
    try:
        if os.path.exists(audio_urls_file):
            os.remove(audio_urls_file)
            print(f"🧹 Deleted: {audio_urls_file}")
        
        if os.path.exists(transcripts_file):
            os.remove(transcripts_file)
            print(f"🧹 Deleted: {transcripts_file}")
    except Exception as e:
        print(f"⚠️ Warning: Could not clean up input files: {e}")

# ----------------------
# Main run with file path arguments
# ----------------------
def main(audio_urls_file, transcripts_file, output_file="matched_audio_transcripts.json"):
    """
    Main function that processes audio URLs and transcripts from specified files
    """
    print(f"📁 Loading audio URLs from {audio_urls_file}...")
    try:
        with open(audio_urls_file, "r", encoding="utf-8") as fa:
            audio_urls_data = json.load(fa)
        print(f"📊 Loaded {len(audio_urls_data)} audio URLs")
    except FileNotFoundError:
        print(f"❌ Error: Audio URLs file '{audio_urls_file}' not found")
        return
    except json.JSONDecodeError:
        print(f"❌ Error: Invalid JSON format in '{audio_urls_file}'")
        return

    print(f"📁 Loading and processing transcripts from {transcripts_file}...")
    try:
        # Use the new parser for structured format
        transcripts_data = parse_structured_transcripts(transcripts_file)
        print(f"📊 Parsed {len(transcripts_data)} transcripts")
    except FileNotFoundError:
        print(f"❌ Error: Transcripts file '{transcripts_file}' not found")
        return

    # Show sample of parsed entries
    print("\n🔍 Sample parsed entries (first 10):")
    for e in transcripts_data[:10]:
        print(f"  Activity {e['activity_number']}: transcript='{e['transcript'][:60]}' type={e['type']} timestamp='{e['timestamp']}' speaker='{e['speaker']}' device='{e['device']}'")

    # Match them
    matched_audio_urls, matched_transcripts = match_audio_with_transcripts(audio_urls_data, transcripts_data)
    print(f"\n🔗 Matched {len(matched_audio_urls)} audio URLs with transcripts")

    # Process duplicates
    filtered_audio_urls, filtered_transcripts = process_duplicates_with_logic(matched_audio_urls, matched_transcripts)
    print(f"\n📊 After duplicate processing: {len(filtered_audio_urls)} audio entries")

    # Final mapping and save
    final_mapping = create_final_mapping(filtered_audio_urls, filtered_transcripts)
    with open(output_file, "w", encoding='utf-8') as fout:
        json.dump(final_mapping, fout, indent=2, ensure_ascii=False)

    print(f"\n✅ Final mapping saved to {output_file} (entries: {len(final_mapping)})")
    
    # Show final statistics
    spoken_count = sum(1 for t in filtered_transcripts if t.get("type") == "spoken")
    system_count = len(filtered_transcripts) - spoken_count
    print(f"📈 Final breakdown: {spoken_count} spoken, {system_count} system entries")

    # Clean up input files after successful processing
    print(f"\n🧹 Cleaning up input files...")
    cleanup_input_files(audio_urls_file, transcripts_file)

if __name__ == "__main__":
    audio_file = "backend/audio_urls.json"
    transcript_file = "alexa_activity_log.txt"
    output_file = "matched_audio_transcripts.json"
    
    print("🔧 Processing files:")
    print(f"   - Audio URLs: {audio_file}")
    print(f"   - Transcripts: {transcript_file}")
    print(f"   - Output: {output_file}")
    print()
    
    main(audio_file, transcript_file, output_file)