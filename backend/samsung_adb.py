#!/usr/bin/env python3
import subprocess
import time
import hashlib
import datetime
import os
import re
import csv
from datetime import datetime as D
from pymongo import MongoClient
import gridfs
import json


# --- MongoDB Setup ---
client = MongoClient("mongodb://localhost:27017/")
db = client["forensic_evidence"]
fs = gridfs.GridFS(db)

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
    """Save data as a BLOB in MongoDB using GridFS."""
    try:
        # Delete old version if exists
        existing = db.fs.files.find_one({"filename": filename})
        if existing:
            fs.delete(existing["_id"])

        if binary:
            file_id = fs.put(data, filename=filename, binary=True, uploadDate=datetime.datetime.now())
        else:
            file_id = fs.put(data.encode("utf-8", "ignore"), filename=filename, binary=False, uploadDate=datetime.datetime.now())

        print(f"[+] Saved '{filename}' to MongoDB with ID: {file_id}")
        return file_id

    except Exception as e:
        print(f"[!] Error saving {filename}: {e}")


def create_json_summary():
    # List all the filenames you saved to GridFS (or locally)
    artifact_files = [
        "device_properties.txt",
        "logcat_capture.txt",
        "account_information.txt",
        "wifi_information.txt",
        "bluetooth_information.txt",
        "ip_address_information.txt",
        "sensor_data.txt",
        "dumpsys_location.txt",
        "keystore_information.txt",
        "trust_information.txt"
    ]
    
    artifacts_summary = {}
    
    for filename in artifact_files:
        try:
            # Read back from GridFS
            file_doc = fs.find_one({"filename": filename})
            print(file_doc)
            if file_doc:
                data = file_doc.read().decode("utf-8", errors="ignore")
                artifacts_summary[filename] = data
                print(f"Successfully read {filename}")
        except Exception as e:
            artifacts_summary[filename] = f"Error reading {filename}: {e}"

    summary = {
        "success": True,
        "message": "Acquisition completed successfully",
        "artifacts": artifacts_summary
    }
    # Write JSON locally so Node can serve it
    with open("packet_report.json", "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2)

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
        "/data/misc/bluedroid/btsnoop_hci.log"
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
        save_to_file(local_file, data, binary=True)
        break

def collect_location_info():
    loc_raw, err = run_adb_command(['shell', 'dumpsys', 'location'], timeout=45)
    save_to_file("dumpsys_location.txt", loc_raw)
    # (rest of your CSV generation stays same)

def extract_activity_info():
    output, _ = run_adb_command(['shell', 'dumpsys', 'activity', 'intents'], timeout=60)
    if not output:
        return
    timestamp = D.now().strftime("%Y%m%d_%H%M%S")
    filename = f"activity_summary_{timestamp}.log"
    save_to_file(filename, output)

def keystore_info():
    keystore_data, _ = run_adb_command(['shell', 'dumpsys', 'keystore'])
    save_to_file("keystore_information.txt", keystore_data)

def trust_info():
    trust_data, _ = run_adb_command(['shell', 'dumpsys', 'trust'])
    save_to_file("trust_information.txt", trust_data)

def main():
    if not check_adb_device():
        print("[-] No ADB device connected.")
        return
    print("[+] Device connected, collecting forensic evidence...")
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
    create_json_summary()

    
if __name__ == "__main__":
    main()