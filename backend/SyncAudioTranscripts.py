import json
import re
from datetime import datetime, timedelta

def get_formatted_date(date_string):
    """
    Convert 'Today' or 'Yesterday' to actual dates, or return the original if already a date.
    Returns format: 'DDth Month, YYYY'
    """
    today = datetime.now()
    
    if "Today" in date_string:
        return today.strftime("%d %B, %Y")
    elif "Yesterday" in date_string:
        yesterday = today - timedelta(days=1)
        return yesterday.strftime("%d %B, %Y")
    else:
        # If it's already a proper date format, return as is
        return date_string

def extract_detailed_transcripts(file_path):
    """
    Reads the transcript file and extracts detailed information for each activity.
    Returns a list of dicts with:
    - transcript: the spoken text (in quotes) or system message
    - type: "spoken" if in quotes, "system" if not
    - timestamp: the formatted date and time
    - speaker: the detected speaker name (if present) or "undefined"
    - device: the device name (e.g., "Bangalore echoshow 8")
    """
    detailed_transcripts = []
    
    with open(file_path, 'r', encoding='utf-8') as f:
        content = f.read()
    
    # Split by activity sections
    activity_sections = re.split(r'--- Activity \d+ ---', content)
    
    for i, section in enumerate(activity_sections[1:], 1):  # Skip first empty section
        lines = [line.strip() for line in section.strip().split('\n') if line.strip()]
        
        if not lines:
            continue
            
        activity_data = {
            "activity_number": i,
            "transcript": "",
            "type": "system",  # Default to system
            "timestamp": "",
            "speaker": "undefined",  # Use "undefined" instead of null
            "device": ""
        }
        
        # First line is the transcript/activity summary
        transcript_line = lines[0]
        activity_data["transcript"] = transcript_line
        
        # Determine if it's spoken (in quotes) or system generated
        if transcript_line.startswith('"') and transcript_line.endswith('"'):
            activity_data["type"] = "spoken"
            # Remove surrounding quotes for the transcript
            activity_data["transcript"] = transcript_line[1:-1]
        
        # Process timestamp and subsequent lines
        for j, line in enumerate(lines):
            if line.startswith("Today") or line.startswith("Yesterday"):
                # Extract the time portion and convert "Today"/"Yesterday" to actual date
                time_match = re.search(r'(Today|Yesterday)\s+(\d{1,2}:\d{2}\s+[ap]m)', line)
                if time_match:
                    date_type, time_part = time_match.groups()
                    formatted_date = get_formatted_date(date_type)
                    activity_data["timestamp"] = f"{formatted_date} {time_part}"
                else:
                    activity_data["timestamp"] = get_formatted_date(line)
                
                # Check if there are more lines after timestamp
                if j + 1 < len(lines):
                    # This is the speaker/device line
                    info_line = lines[j + 1]
                    
                    # Pattern 1: SpeakerName + Device (e.g., "SherwinBangalore echoshow 8")
                    # Extract speaker name (capitalized word at beginning)
                    speaker_match = re.match(r'^([A-Z][a-z]+)', info_line)
                    if speaker_match:
                        speaker_name = speaker_match.group(1)
                        activity_data["speaker"] = speaker_name
                        
                        # The rest is the device name (may include location like "Bangalore")
                        device_part = info_line[len(speaker_name):].strip()
                        if device_part:
                            activity_data["device"] = device_part
                    
                    # Pattern 2: Complex device names (e.g., "RajkumarRajkumar's 2nd Fire TV Edition TV")
                    elif "'" in info_line or "Fire TV" in info_line:
                        # Try to extract speaker from the beginning
                        complex_speaker_match = re.match(r'^([A-Z][a-z]+)', info_line)
                        if complex_speaker_match:
                            speaker_name = complex_speaker_match.group(1)
                            activity_data["speaker"] = speaker_name
                        
                        # The entire line is essentially the device description
                        activity_data["device"] = info_line
                    
                    # Pattern 3: If no clear speaker pattern, check if it's just a device name
                    elif any(device_keyword in info_line.lower() for device_keyword in ['echo', 'fire tv', 'alexa', 'dot']):
                        activity_data["device"] = info_line
                    
                    # Pattern 4: Default - use the whole line as device
                    else:
                        activity_data["device"] = info_line
                
                break
        
        detailed_transcripts.append(activity_data)
    
    return detailed_transcripts

def process_duplicates_with_logic(audio_urls, transcripts_data):
    """
    Process audio URLs and transcripts with the duplicate handling logic:
    1. Remove activities with "type":"system" when duplicate audio URLs are detected
    2. Keep all activities with "type":"spoken" even with duplicate URLs
    3. Maintain proper ordering for remaining activities
    """
    filtered_audio_urls = []
    filtered_transcripts = []
    
    i = 0
    while i < len(audio_urls):
        current_url = audio_urls[i]
        current_transcript = transcripts_data[i]
        
        # Check if this URL appears again in subsequent positions
        duplicate_indices = []
        j = i + 1
        while j < len(audio_urls) and audio_urls[j] == current_url:
            duplicate_indices.append(j)
            j += 1
        
        if duplicate_indices:
            # We have duplicates starting from index i
            all_indices = [i] + duplicate_indices
            all_transcripts = [transcripts_data[idx] for idx in all_indices]
            
            # Filter: keep only transcripts with type "spoken"
            spoken_transcripts = [t for t in all_transcripts if t["type"] == "spoken"]
            
            if spoken_transcripts:
                # We have at least one "spoken" transcript for this duplicate URL
                # Add all spoken transcripts with their corresponding URL
                for transcript in spoken_transcripts:
                    filtered_audio_urls.append(current_url)
                    # Create a copy without activity_number
                    transcript_copy = transcript.copy()
                    if "activity_number" in transcript_copy:
                        del transcript_copy["activity_number"]
                    filtered_transcripts.append(transcript_copy)
                
                print(f"🔊 Duplicate URL group (indices {all_indices}):")
                print(f"   - Kept {len(spoken_transcripts)} 'spoken' activities")
                print(f"   - Removed {len(all_transcripts) - len(spoken_transcripts)} 'system' activities")
            
            else:
                # No spoken transcripts in this duplicate group, skip all
                print(f"🔊 Duplicate URL group (indices {all_indices}):")
                print(f"   - Removed all {len(all_transcripts)} activities (all were 'system' type)")
            
            # Move i to the position after all duplicates
            i = j
            
        else:
            # No duplicates for this URL, just add it
            filtered_audio_urls.append(current_url)
            # Create a copy without activity_number
            transcript_copy = current_transcript.copy()
            if "activity_number" in transcript_copy:
                del transcript_copy["activity_number"]
            filtered_transcripts.append(transcript_copy)
            i += 1
    
    return filtered_audio_urls, filtered_transcripts

def create_final_mapping(audio_urls, transcripts_data):
    """
    Create the final mapping between audio URLs and transcripts
    """
    final_mapping = {}
    
    for url, transcript in zip(audio_urls, transcripts_data):
        # Use the URL as key and transcript data as value
        final_mapping[url] = transcript
    
    return final_mapping

# Load audio URLs from the JSON file
print("📁 Loading audio URLs from audio_urls.json...")
with open("backend/audio_urls.json", 'r') as f:
    audio_urls = json.load(f)

print(f"📊 Loaded {len(audio_urls)} audio URLs")

# Extract detailed transcripts from the transcript file
print("📁 Loading and processing transcripts from alexa_activity_log.txt...")
transcripts_data = extract_detailed_transcripts('alexa_activity_log.txt')
print(f"📊 Loaded {len(transcripts_data)} transcripts")

# Display sample of extracted data for verification
print("\n🔍 Sample of extracted transcript data:")
for i in range(min(5, len(transcripts_data))):
    entry = transcripts_data[i]
    print(f"   Activity {entry['activity_number']}:")
    print(f"     Transcript: {entry['transcript']}")
    print(f"     Type: {entry['type']}")
    print(f"     Timestamp: {entry['timestamp']}")
    print(f"     Speaker: {entry['speaker']}")
    print(f"     Device: {entry['device']}")

# Check if we have matching counts
if len(audio_urls) != len(transcripts_data):
    print(f"⚠️  WARNING: Mismatch in counts - Audio URLs: {len(audio_urls)}, Transcripts: {len(transcripts_data)}")
    print("   This might affect the matching logic.")

print("\n🔍 Applying duplicate processing logic...")
print("   Logic:")
print("   1. For duplicate audio URLs, remove 'system' type activities")
print("   2. Keep all 'spoken' type activities even with duplicate URLs")
print("   3. Maintain proper ordering for remaining activities")

# Process with duplicate logic
filtered_audio_urls, filtered_transcripts = process_duplicates_with_logic(audio_urls, transcripts_data)

print(f"\n📊 AFTER PROCESSING:")
print(f"   • Original audio URLs: {len(audio_urls)}")
print(f"   • Original transcripts: {len(transcripts_data)}")
print(f"   • Filtered audio URLs: {len(filtered_audio_urls)}")
print(f"   • Filtered transcripts: {len(filtered_transcripts)}")

# Create the final mapping
print("\n🔗 Creating final mapping...")
final_mapping = create_final_mapping(filtered_audio_urls, filtered_transcripts)

# Count types in final output
spoken_count = sum(1 for transcript in filtered_transcripts if transcript.get("type") == "spoken")
system_count = sum(1 for transcript in filtered_transcripts if transcript.get("type") == "system")

print(f"📊 FINAL OUTPUT BREAKDOWN:")
print(f"   • Total entries: {len(final_mapping)}")
print(f"   • 'spoken' type: {spoken_count}")
print(f"   • 'system' type: {system_count}")

# Output the mapping as JSON
matched_json = json.dumps(final_mapping, indent=2)
print("\n🎯 Final Matched Audio URLs with Detailed Transcripts:")
print(matched_json)

# Write the mapping to a JSON file
with open("matched_audio_transcripts.json", "w") as f:
    json.dump(final_mapping, f, indent=2)

print(f"\n✅ Final mapping saved to: matched_audio_transcripts.json")
print(f"💾 File contains {len(final_mapping)} matched entries")