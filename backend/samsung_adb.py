#!/usr/bin/env python3
import subprocess
import time
import hashlib
import datetime
import os
import re
import csv
from datetime import datetime as D

def run_adb_command(command, timeout=30):
    """Run an ADB command and return (stdout, stderr)."""
    proc = subprocess.run(['adb'] + command, capture_output=True, text=True, timeout=timeout)
    return proc.stdout.strip(), proc.stderr.strip()

def check_adb_device():
    """Check if the device is connected."""
    devices_out, error = run_adb_command(['devices'])
    if error:
        return False
    lines = [l.strip() for l in devices_out.splitlines() if l.strip()]
    if any((line.endswith("device") or "\tdevice" in line) and not line.startswith("List of devices") for line in lines[1:]):
        return True
    return False

def save_to_file(filename, data, binary=False):
    """Save extracted data to file (text or binary)."""
    mode = 'wb' if binary else 'w'
    enc = None if binary else 'utf-8'
    with open(filename, mode, encoding=enc, errors='ignore') as file:
        if binary:
            file.write(data)
        else:
            file.write(data)

def collect_device_properties():
    props, _ = run_adb_command(['shell', 'getprop'])
    save_to_file("device_properties.txt", props)

def pull_logs():
    logcat_data, _ = run_adb_command(['logcat', '-d'], timeout=120)
    save_to_file("logcat_capture.txt", logcat_data)

def collect_account_info():
    acc_info, _ = run_adb_command(['shell', 'dumpsys', 'account'])
    save_to_file("account_information.txt", acc_info)

def wifi_info():
    wifi_out, _ = run_adb_command(['shell', 'dumpsys', 'wifi'])
    save_to_file("wifi_information.txt", wifi_out)

def ip_info():
    ip_out, _ = run_adb_command(['shell', 'ip', 'addr', 'show'])
    save_to_file("ip_address_information.txt", ip_out)

def bluetooth_info():
    bt_out, _ = run_adb_command(['shell', 'dumpsys', 'bluetooth_manager'])
    save_to_file("bluetooth_information.txt", bt_out)

def sensor_data():
    s_out, _ = run_adb_command(['shell', 'dumpsys', 'sensorservice'])
    save_to_file("sensor_data.txt", s_out)

def bluetooth_snoop():
    paths = [
        "/sdcard/btsnoop_hci.log",
        "/sdcard/btsnoop.log",
        "/data/misc/bluetooth/logs/btsnoop_hci.log",
        "/data/misc/bluetooth/btsnoop_hci.log",
        "/data/misc/bluedroid/btsnoop_hci.log",
    ]
    for path in paths:
        out = subprocess.run(["adb", "shell", "ls", path], capture_output=True, text=True)
        if "No such file" in out.stdout or "No such file" in out.stderr:
            continue
        ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        local_file = f"btsnoop_{ts}.log"
        pull = subprocess.run(["adb", "pull", path, local_file], capture_output=True, text=True)
        if "does not exist" in pull.stderr or not os.path.exists(local_file):
            continue
        with open(local_file, "rb") as f:
            data = f.read()
        hashlib.sha256(data).hexdigest()
        hashlib.md5(data).hexdigest()
        break

def collect_location_info():
    loc_raw, err = run_adb_command(['shell', 'dumpsys', 'location'], timeout=45)
    if not loc_raw:
        save_to_file("dumpsys_location.txt", "")
        return

    save_to_file("dumpsys_location.txt", loc_raw)

    regex = re.compile(
        r'Location\[(?:provider=)?(?P<provider>[\w\-]+)?\s*(?P<lat>-?\d+\.\d+)[, ]+(?P<lon>-?\d+\.\d+).*?(?:hAcc=(?P<acc>\d+\.?\d*))?',
        re.IGNORECASE | re.DOTALL
    )

    matches = list(regex.finditer(loc_raw))
    if not matches:
        save_to_file("locations_parsed.csv", "timestamp,provider,lat,lon,accuracy\n")
        return
    
    csv_rows = []
    for m in matches:
        provider = m.group('provider') or 'unknown'
        lat = m.group('lat')
        lon = m.group('lon')
        acc = m.group('acc') or ''
        ts = datetime.datetime.now().isoformat()
        csv_rows.append((ts, provider, lat, lon, acc))

    csv_file = "locations_parsed.csv"
    with open(csv_file, 'w', newline='', encoding='utf-8') as cf:
        writer = csv.writer(cf)
        writer.writerow(['timestamp', 'provider', 'lat', 'lon', 'accuracy'])
        writer.writerows(csv_rows)

def extract_activity_info():
    output, _ = run_adb_command(['shell', 'dumpsys', 'activity', 'intents'], timeout=60)
    if not output:
        return

    app_blocks = re.split(r'\n\s*\*\s+', output)
    forensic_summary = []
    timestamp = D.now().strftime("%Y%m%d_%H%M%S")
    log_filename = f"activity_summary_{timestamp}.log"

    with open(log_filename, "w", encoding="utf-8") as log:
        log.write("=== FORENSIC ACTIVITY MANAGER SUMMARY ===\n")
        log.write(f"Generated: {timestamp}\n\n")

        for block in app_blocks:
            match_app = re.match(r"([a-zA-Z0-9\._-]+):", block)
            if not match_app:
                continue
            app_name = match_app.group(1)
            intent_lines = re.findall(r"PendingIntentRecord\{[^\}]+\}", block)
            intent_count = len(intent_lines)
            start_activity = len(re.findall(r"startActivity", block))
            broadcast_intent = len(re.findall(r"broadcastIntent", block))

            summary = {
                "app": app_name,
                "total": intent_count,
                "startActivity": start_activity,
                "broadcastIntent": broadcast_intent
            }
            forensic_summary.append(summary)
            log.write(f"[App] {app_name}\n")
            log.write(f"  • Total Pending Intents: {intent_count}\n")
            log.write(f"  • startActivity: {start_activity}\n")
            log.write(f"  • broadcastIntent: {broadcast_intent}\n\n")

def keystore_info():
    keystore_data, _ = run_adb_command(['shell', 'dumpsys', 'keystore'])
    save_to_file("keystore_information.txt", keystore_data)

def trust_info():
    trust_data, _ = run_adb_command(['shell', 'dumpsys', 'trust'])
    save_to_file("trust_information.txt", trust_data)

def main():
    if not check_adb_device():
        return
    time.sleep(1)
    collect_device_properties()
    pull_logs()
    collect_account_info()
    wifi_info()
    bluetooth_info()
    ip_info()
    bluetooth_snoop()
    sensor_data()
    collect_location_info()
    extract_activity_info()
    keystore_info()
    trust_info()

if __name__ == "__main__":
    main()
