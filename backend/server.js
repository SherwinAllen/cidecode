const express = require('express');
const cors = require('cors');
const app = express();
const { MongoClient, GridFSBucket } = require('mongodb');
const path = require('path');
const { exec, spawn } = require('child_process');
const fs = require('fs');
const { randomUUID } = require('crypto');
const tar = require('tar-stream');

app.use(cors());
app.use(express.json());

// Serve static files from the backup directory
app.use('/api/files', express.static(path.join(__dirname, 'backup')));

// Use MONGO_URI from env (set by docker-compose) or fallback to localhost
const mongoURI = process.env.MONGO_URI || process.env.MONGO_URL || "mongodb://localhost:27017/forensic_evidence";
let db, gfs, mongoClient;

const connectDB = async () => {
  try {
    mongoClient = new MongoClient(mongoURI, { useNewUrlParser: true, useUnifiedTopology: true });
    await mongoClient.connect();
    db = mongoClient.db(); // DB name taken from URI if present
    gfs = new GridFSBucket(db, { bucketName: 'fs' });
    console.log(' Connected to MongoDB at', mongoURI);
  } catch (error) {
    console.error(' MongoDB connection error:', error);
    throw error;
  }
};

// === MongoDB Artifact Routes ===
app.get("/", (req, res) => {
  res.json({ message: "Forensic Artifact Express API is running" });
});

app.get("/artifacts", async (req, res) => {
  /** List all stored artifacts. */
  try {
    const files = await db.collection('fs.files')
      .find()
      .sort({ uploadDate: -1 })
      .toArray();
    
    const result = files.map(f => ({
      filename: f.filename,
      uploadDate: f.uploadDate.toISOString(),
      size: f.length
    }));
    
    res.json({ artifacts: result });
  } catch (error) {
    console.error('Error listing artifacts:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get("/artifact/content/:filename", async (req, res) => {
  /** Return the text content of a file for preview. */
  try {
    const { filename } = req.params;
    const file = await db.collection('fs.files').findOne({ filename });
    
    if (!file) {
      return res.status(404).json({ error: "File not found" });
    }

    const downloadStream = gfs.openDownloadStreamByName(filename);
    let data = '';
    
    downloadStream.on('data', (chunk) => {
      data += chunk.toString('utf8');
    });
    
    downloadStream.on('end', () => {
      res.json({ filename, content: data });
    });
    
    downloadStream.on('error', (error) => {
      console.error('Error reading file:', error);
      res.status(500).json({ error: error.message });
    });
    
  } catch (error) {
    console.error('Error getting artifact content:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get("/artifact/download/:filename", async (req, res) => {
  /** Download the full file. */
  try {
    const { filename } = req.params;
    console.log(`Download request for: ${filename}`);
    
    const file = await db.collection('fs.files').findOne({filename});
    if (!file) {
      return res.status(404).json({ error: "File not found" });
    }
    
    console.log("File found:", filename);
    
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    
    const downloadStream = gfs.openDownloadStreamByName(filename);
    downloadStream.pipe(res);
    
    downloadStream.on('error', (error) => {
      console.error('Error downloading file:', error);
      res.status(500).json({ error: error.message });
    });
    
  } catch (error) {
    console.error('Error in download endpoint:', error);
    res.status(500).json({ error: error.message });
  }
});

// Download file from device
app.get('/api/download-file', async (req, res) => {
  const filePath = req.query.path;
  
  if (!filePath) {
    return res.status(400).json({ error: 'File path is required' });
  }
  
  try {
    await checkAdbDevice();
    
    // Pull file to temporary location
    const tempDir = path.join(__dirname, 'temp_files');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    
    const fileName = path.basename(filePath);
    const localPath = path.join(tempDir, fileName);
    
    console.log(` Pulling file: ${filePath}`);
    await runAdbCommand(`adb pull "/sdcard/${filePath}" "${localPath}"`);
    
    // Determine content type
    const ext = path.extname(filePath).toLowerCase();
    const contentTypes = {
      '.txt': 'text/plain',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.pdf': 'application/pdf',
      '.mp3': 'audio/mpeg',
      '.mp4': 'video/mp4',
      '.json': 'application/json',
      '.xml': 'application/xml',
      '.html': 'text/html',
      '.css': 'text/css',
      '.js': 'application/javascript'
    };
    
    const contentType = contentTypes[ext] || 'application/octet-stream';
    
    // Send file
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
    
    const fileStream = fs.createReadStream(localPath);
    fileStream.pipe(res);
    
    // Clean up temp file after sending
    fileStream.on('end', () => {
      setTimeout(() => {
        fs.unlink(localPath, (err) => {
          if (err) console.error('Error deleting temp file:', err);
        });
      }, 1000);
    });
    
  } catch (err) {
    console.error('Error downloading file:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get file preview (for text files)
app.get('/api/file-preview', async (req, res) => {
  const filePath = req.query.path;
  const includeContent = req.query.include_content === 'true';
  console.log("The path sent to the preview:", filePath)
  if (!filePath) {
    return res.status(400).json({ error: 'File path is required' });
  }
  
  // Security: Basic path validation
  if (filePath.includes('..') || filePath.includes('//')) {
    return res.status(400).json({ error: 'Invalid file path' });
  }
  
  try {
    await checkAdbDevice();
    
    // Get file info first
    const fileInfo = await runAdbCommand(`adb shell "stat -c '%s' '/sdcard/${filePath}'"`);
    const fileSize = parseInt(fileInfo.trim());
    
    if (isNaN(fileSize)) {
      return res.status(404).json({ error: 'File not found or inaccessible' });
    }
    
    const ext = path.extname(filePath).toLowerCase();
    console.log("Lenght is:",ext.length)
    const isTextFile = ['.txt', '.json', '.xml', '.html', '.css', '.js', '.log', '.md', '.csv'].includes(ext);
    const isImage = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'].includes(ext);
    const isAudio = ['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac'].includes(ext);
    
    // Determine MIME type
    let mimeType = 'application/octet-stream';
    if (isTextFile) {
      if (ext === '.json') mimeType = 'application/json';
      else if (ext === '.html') mimeType = 'text/html';
      else if (ext === '.css') mimeType = 'text/css';
      else if (ext === '.js') mimeType = 'application/javascript';
      else mimeType = 'text/plain';
    } else if (isImage) {
      if (ext === '.jpg' || ext === '.jpeg') mimeType = 'image/jpeg';
      else if (ext === '.png') mimeType = 'image/png';
      else if (ext === '.gif') mimeType = 'image/gif';
      else if (ext === '.bmp') mimeType = 'image/bmp';
      else if (ext === '.webp') mimeType = 'image/webp';
    } else if (isAudio) {
      if (ext === '.mp3') mimeType = 'audio/mpeg';
      else if (ext === '.wav') mimeType = 'audio/wav';
      else if (ext === '.ogg') mimeType = 'audio/ogg';
      else if (ext === '.m4a') mimeType = 'audio/mp4';
      else if (ext === '.flac') mimeType = 'audio/flac';
      else mimeType = 'audio/mpeg';
    }
    console.log("The audio extension is:",isAudio)
    const response = {
      path: filePath,
      name: path.basename(filePath),
      size: fileSize,
      mimeType: mimeType,
      isText: isTextFile,
      preview: 'Binary file'
    };
    
    // Only load content if explicitly requested and file is small enough
    if (includeContent) { // 1MB limit
      try {
        if (isTextFile) {
          // For text files, get content directly
          const fileContent = await runAdbCommand(`adb shell "cat '/sdcard/${filePath}'"`, { 
            maxBuffer: 1024 * 1024 * 1024 * 1024 * 1024 
          });
          response.content = fileContent;
          response.preview = fileContent.substring(0, 200) + (fileContent.length > 200 ? '...' : '');
        } else if (isImage || isAudio) {
          // For images, get base64 content
          const base64Content = await runAdbCommand(`adb shell "cat '/sdcard/${filePath}' | base64"`, {
            maxBuffer: 1024 * 1024 * 1024 * 1024 * 1024  // 5MB for base64 encoded images
          });
          response.content = base64Content.trim();
          response.encoding = 'base64';
          response.preview = `Image file (${fileSize} bytes)`;
        }
      } catch (contentError) {
        console.warn(`Could not load content for ${filePath}:`, contentError.message);
        // Don't fail the entire request if content can't be loaded
      }
    } else if (isTextFile && fileSize < 1024 * 10) { // Auto-include small text files (<10KB)
      try {
        const fileContent = await runAdbCommand(`adb shell "cat '/sdcard/${filePath}'"`);
        response.content = fileContent;
        response.preview = fileContent.substring(0, 200) + (fileContent.length > 200 ? '...' : '');
      } catch (contentError) {
        // Ignore errors for small files
      }
    }
    
    res.json(response);
    
  } catch (err) {
    console.error('Error getting file preview:', err);
    res.status(500).json({ error: err.message });
  }
});

async function checkAdbDevice() {
  try {
    const devicesOutput = await runAdbCommand('adb devices');
    const lines = devicesOutput.split('\n').filter(line => line.trim());
    
    // Skip the first line ("List of devices attached")
    const deviceLines = lines.slice(1);
    
    if (deviceLines.length === 0) {
      throw new Error('No devices connected');
    }

    const authorizedDevices = deviceLines.filter(line => line.includes('\tdevice'));
    if (authorizedDevices.length === 0) {
      throw new Error('No authorized devices found. Check USB debugging authorization.');
    }

    console.log(` Found ${authorizedDevices.length} authorized device(s)`);
    return true;
  } catch (error) {
    throw new Error(`Device check failed: ${error.message}`);
  }
}

function runAdbCommand(command, options = {}) {
  return new Promise((resolve, reject) => {
    console.log(` Running ADB: ${command}`);
    exec(command, { maxBuffer: 1024 * 1024 * 100, ...options }, (error, stdout, stderr) => {
      if (error) {
        console.error(` ADB command failed: ${error.message}`);
        reject(new Error(`ADB command failed: ${stderr || error.message}`));
        return;
      }
      if (stderr && !options.ignoreStderr) {
        console.warn(` ADB stderr: ${stderr}`);
      }
      resolve(stdout);
    });
  });
}

// Proper recursive folder scanning
async function scanFolderRecursive(basePath, currentPath = '', depth = 0) {
  const fullPath = basePath + currentPath;
  
  // Safety limit to prevent infinite recursion
  if (depth > 8) {
    return {
      name: currentPath.split('/').pop() || 'sdcard',
      type: 'folder',
      path: currentPath,
      children: [],
      partial: true,
      info: 'Depth limit reached'
    };
  }
  
  try {
    console.log(` Scanning (depth ${depth}): ${fullPath}`);
    
    // Get all items (simple list)
    const itemsOutput = await runAdbCommand(`adb shell "ls -1 '${fullPath}'"`, { ignoreStderr: true });
    const items = itemsOutput.split('\n').filter(item => item.trim());
    
    const folderNode = {
      name: currentPath.split('/').pop() || 'sdcard',
      type: 'folder',
      path: currentPath,
      children: []
    };

    for (const itemName of items) {
      if (!itemName || itemName === '.' || itemName === '..') continue;
      
      const fullItemPath = `${fullPath}/${itemName}`;
      const relativePath = currentPath ? `${currentPath}/${itemName}` : itemName;
      
      // Check if it's a directory
      const isDir = await runAdbCommand(`adb shell "if [ -d '${fullItemPath}' ]; then echo 'dir'; fi"`, { 
        ignoreStderr: true 
      }).then(output => output.includes('dir')).catch(() => false);
      
      if (isDir) {
        // RECURSIVE CALL - scan the subfolder
        try {
          const subFolder = await scanFolderRecursive(basePath, relativePath, depth + 1);
          folderNode.children.push(subFolder);
        } catch (subError) {
          folderNode.children.push({
            name: itemName,
            type: 'folder',
            path: relativePath,
            children: [],
            error: subError.message,
            partial: true
          });
        }
      } else {
        // It's a file
        folderNode.children.push({
          name: itemName,
          type: 'file',
          path: relativePath
        });
      }
    }

    console.log(` ${fullPath}: ${folderNode.children.length} items`);
    return folderNode;
    
  } catch (error) {
    console.error(` Error scanning folder ${fullPath}:`, error.message);
    throw error;
  }
}

// NEW: Get list of top-level folders in /sdcard
app.get('/api/scan-folders', async (req, res) => {
  try {
    console.log(' Scanning for top-level folders...');
    await checkAdbDevice();
    
    const lsOutput = await runAdbCommand('adb shell ls -la /sdcard/', { ignoreStderr: true });
    const lines = lsOutput.split('\n').filter(line => line.trim());
    
    const folderNames = [];
    
    for (const line of lines) {
      if (line.startsWith('d')) { // Directory lines
        const parts = line.split(/\s+/);
        const name = parts[parts.length - 2];
        console.log("Folder name is:",name);
        
        if (name && !name.startsWith('.') && name !== 'Android' && name !== 'lost+found') {
          folderNames.push(name);
        }
      }
    }
    
    console.log(` Found ${folderNames.length} folders:`, folderNames);
    res.json(folderNames);
  } catch (err) {
    console.error(' Folder scan error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// NEW: Get contents of a specific folder
app.get('/api/scan-folder', async (req, res) => {
  const folderPath = req.query.path;
  
  if (!folderPath) {
    return res.status(400).json({ error: 'Folder path is required' });
  }
  
  try {
    console.log(` Scanning folder: ${folderPath}`);
    await checkAdbDevice();
    
    const folderData = await scanFolderRecursive('/sdcard/', folderPath);
    res.json(folderData);
  } catch (err) {
    console.error(` Error scanning folder ${folderPath}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// NEW: Quick scan of common folders only (faster alternative)
app.get('/api/quick-scan', async (req, res) => {
  try {
    console.log(' Starting quick scan of common folders...');
    await checkAdbDevice();
    
    const commonFolders = ['DCIM', 'Download', 'Pictures', 'Music', 'Documents', 'Movies', 'Podcasts'];
    const root = {
      name: 'sdcard',
      type: 'folder',
      children: []
    };
    
    for (const folder of commonFolders) {
      try {
        console.log(` Quick scanning: ${folder}`);
        // Check if folder exists and get basic info
        const exists = await runAdbCommand(`adb shell "test -d /sdcard/${folder} && echo exists"`, { ignoreStderr: true })
          .then(output => output.includes('exists'))
          .catch(() => false);
        
        if (exists) {
          // Get file count for this folder
          const fileCount = await runAdbCommand(`adb shell "find /sdcard/${folder} -type f | wc -l"`, { ignoreStderr: true })
            .then(output => parseInt(output.trim()) || 0)
            .catch(() => 0);
          
          root.children.push({
            name: folder,
            type: 'folder',
            path: folder,
            fileCount: fileCount,
            children: [] // Don't recursively scan in quick mode
          });
        }
      } catch (error) {
        root.children.push({
          name: folder,
          type: 'folder',
          path: folder,
          error: error.message,
          children: []
        });
      }
    }
    
    console.log(' Quick scan completed');
    res.json(root);
  } catch (err) {
    console.error(' Quick scan error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Original filesystem endpoint (with fallback)
app.get('/api/filesystem', async (req, res) => {
  try {
    console.log(' Starting filesystem fetch from smartwatch...');
    
    //  Just call the performQuickScan function we created earlier
    const result = await performQuickScan();
    res.json(result);
    
  } catch (err) {
    console.error(' Filesystem fetch error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// NEW: Device status endpoint for frontend
app.get('/api/device-status', async (req, res) => {
  try {
    await checkAdbDevice();
    res.json({ 
      status: 'connected',
      message: 'Device is connected and authorized'
    });
  } catch (error) {
    res.json({
      status: 'disconnected',
      message: error.message
    });
  }
});



// New API route
app.get('/api/filesystem', async (req, res) => {
  try {
    console.log('Fetching filesystem from smartwatch...');
    const fsTree = await buildFilesystemTree();
    res.json(fsTree);
  } catch (err) {
    console.error(' Filesystem fetch error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Simple GET endpoint used previously by SmartWatch flows
app.get('/api/packet-report', async (req, res) => {
  const { source } = req.query;
  console.log('Request came from:', source);

  if (source === 'SmartWatch') {
    try {
      const script1 = path.join(__dirname, 'samsung_adb.py');
      const script2 = path.join(__dirname, 'report_gen.py');

      console.log("Executing Python scripts for SmartWatch...");
      
      // Run the scripts sequentially
      await new Promise((resolve, reject) => {
        const cmd = `python "${script1}" && python "${script2}"`;
        exec(cmd, { maxBuffer: 1024 * 1024 * 50 }, (error, stdout, stderr) => {
          if (error) {
            console.error(`Error generating SmartWatch report:`, error, stderr);
            return reject(error);
          }
          console.log(" Report generated successfully!");
          console.log(stdout);
          resolve();
        });
      });
      // Path to the generated DOCX
      const docxPath = path.join(__dirname, '..', 'Forensic_Log_Report.docx');

      //  Read artifacts from JSON file instead of .txt
      const jsonPath = path.join(__dirname,  "..", 'packet_report.json');
      let artifacts = {};

      if (fs.existsSync(jsonPath)) {
        jsonData = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
        artifacts = jsonData.artifacts || {};  // Ensure your package.json has an "artifacts" key
      }

      console.log("Artifacts loaded:", Object.keys(artifacts));

      //  Return JSON (not a blob)
      res.json({
        success: true,
        docxFileName: 'Forensic_Log_Report.docx',
        downloadUrl: '/api/download/Forensic_Log_Report.docx',
        artifacts
      });

    } catch (err) {
      console.error('Error generating SmartWatch report:', err);
      res.status(500).json({ error: 'Failed to generate SmartWatch report', details: err.message });
    }
  } else {
    // You can keep your existing SmartAssistant / fallback JSON logic
    console.log('Source is neither SmartWatch nor SmartAssistant');
    const jsonPath = path.join(__dirname, 'packet_report.json');
    res.sendFile(jsonPath, (err) => {
      if (err) {
        console.error('Error sending JSON file:', err);
        res.status(500).send('Error sending JSON file');
      }
    });
  }
});

app.get('/api/download/fileName', (req, res) => {
  const fileName = req.params.fileName;
  const filePath = path.join(__dirname, '..', fileName);

  if (!fs.existsSync(filePath)) {
    console.error("File not found:", filePath);
    return res.status(404).send('File not found');
  }

  res.download(filePath);
});


// In-memory store for live SmartAssistant requests
const requests = {}; // requestId -> { status, step, progress, logs, method, message, otp, filePath, done, error, userConfirmed2FA, currentUrl, errorType }

// Clean up previous pipeline files
function cleanupPreviousPipelineFiles() {
  const filesToCleanup = [
    'backend/audio_urls.json',
    'alexa_activity_log.txt', 
    'matched_audio_transcripts.json',
    'enhanced_audio_transcripts.json',
    'smart_assistant_report.html'
  ];
  
  console.log(' Cleaning up previous pipeline files...');
  
  filesToCleanup.forEach(filePath => {
    try {
      const fullPath = path.join(__dirname, '..', filePath);
      if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
        console.log(`   Deleted: ${filePath}`);
      }
    } catch (error) {
      console.log(`   Could not delete ${filePath}: ${error.message}`);
    }
  });
  
  // Also clean up downloaded_audio directory if it exists
  const audioDir = path.join(__dirname, '..', 'downloaded_audio');
  try {
    if (fs.existsSync(audioDir)) {
      fs.readdirSync(audioDir).forEach(file => {
        fs.unlinkSync(path.join(audioDir, file));
      });
      fs.rmdirSync(audioDir);
      console.log('   Deleted: downloaded_audio directory');
    }
  } catch (error) {
    console.log(`   Could not clean up audio directory: ${error.message}`);
  }
}

// POST entrypoint from frontend SmartAssistant to start headless pipeline
app.post('/api/packet-report', (req, res) => {
  const { email, password, source } = req.body;
  console.log('Received email:', email);
  console.log('Received password:', password ? '***' : null);
  console.log('Request came from:', source);

  if (source !== 'SmartAssistant') {
    return res.status(400).send('Invalid source');
  }

  // Clean up previous pipeline files before starting new one
  cleanupPreviousPipelineFiles();

  // create request id and initial state
  const requestId = randomUUID();
  requests[requestId] = {
    status: 'started',
    step: 'init',
    progress: 0,
    logs: [
      { timestamp: new Date().toISOString(), message: 'Starting data acquisition process...' }
    ],
    method: null,
    message: null,
    otp: null,
    filePath: null,
    done: false,
    error: null,
    errorType: null,
    userConfirmed2FA: false,
    currentUrl: null,
    showOtpModal: false,
    otpError: null,
    // NEW: Track child processes for cancellation
    childProcesses: [],
    // FIXED: Simplified OTP tracking
    otpRetryCount: 0,
    maxOtpRetries: 3,
    authCompleted: false
  };

  // respond immediately with requestId so frontend can show UI
  res.json({ requestId });

  // Helper function to add logs and update progress
  const addLog = (message, progress = null) => {
    if (requests[requestId]) {
      // Only add log if it's different from the last one to avoid duplicates
      const lastLog = requests[requestId].logs[requests[requestId].logs.length - 1];
      if (!lastLog || lastLog.message !== message) {
        const newLog = {
          timestamp: new Date().toISOString(),
          message: message
        };
        requests[requestId].logs.push(newLog);
        
        // Update progress if provided
        if (progress !== null) {
          requests[requestId].progress = progress;
        }
        
        console.log(`[${requestId}] LOG: ${message}`);
      }
    }
  };

  // Helper function to update current URL
  const updateCurrentUrl = (url) => {
    if (requests[requestId]) {
      requests[requestId].currentUrl = url;
    }
  };

  // FIXED: Enhanced cancelPipeline function with proper state cleanup
  const cancelPipeline = async (errorType, errorMessage) => {
    if (requests[requestId]) {
      console.log(`[${requestId}] Cancelling pipeline due to: ${errorType}`);
      
      // Add cancellation log
      if (requests[requestId].logs) {
        requests[requestId].logs.push({
          timestamp: new Date().toISOString(),
          message: 'Data acquisition cancelled. Cleaning up...'
        });
      }
      
      // Kill all child processes gracefully
      const cleanupPromises = requests[requestId].childProcesses.map(async (child) => {
        try {
          if (!child.killed) {
            console.log(`[${requestId}] Terminating child process...`);
            
            // For spawn processes, use kill with SIGTERM first, then SIGKILL
            if (child.kill) {
              child.kill('SIGTERM');
              console.log(`[${requestId}] Sent SIGTERM to child process`);
              
              // Set timeout for force kill
              return new Promise((resolve) => {
                const timeout = setTimeout(() => {
                  if (!child.killed) {
                    child.kill('SIGKILL');
                    console.log(`[${requestId}] Force killed child process with SIGKILL`);
                  }
                  resolve();
                }, 3000);
                
                // Clear timeout if process exits normally
                child.on('exit', () => {
                  clearTimeout(timeout);
                  console.log(`[${requestId}] Child process exited normally`);
                  resolve();
                });
              });
            } else {
              // For exec processes, just kill them
              child.kill();
              console.log(`[${requestId}] Killed exec child process`);
            }
          }
        } catch (err) {
          console.warn(`[${requestId}] Error killing child process:`, err.message);
        }
      });

      // Wait for all cleanup to complete
      await Promise.all(cleanupPromises);
      
      // Clear the array
      requests[requestId].childProcesses = [];
      
      // Set cancellation state
      requests[requestId].errorType = errorType;
      requests[requestId].status = 'cancelled';
      requests[requestId].error = errorMessage;
      requests[requestId].done = false;
      
      console.log(`[${requestId}] Pipeline cancelled and cleaned up`);
    }
  };

  // FIXED: COMPLETELY REWRITTEN OTP handling
  const handleOtpSuccess = () => {
    if (requests[requestId]) {
      console.log(`[${requestId}] OTP verification successful, clearing all error states`);
      requests[requestId].errorType = null;
      requests[requestId].otpError = null;
      requests[requestId].showOtpModal = false;
      requests[requestId].otpRetryCount = 0; // Reset retry count on success
      addLog('OTP verification successful! Continuing data extraction...', 50);
    }
  };

  const handleOtpFailure = () => {
    if (requests[requestId]) {
      // Check if we've exceeded max retries
      if (requests[requestId].otpRetryCount >= requests[requestId].maxOtpRetries) {
        cancelPipeline('MAX_OTP_RETRIES_EXCEEDED', 'Maximum OTP retry attempts exceeded');
        addLog('Too many failed OTP attempts. Please try again later.', null);
        return;
      }
      
      // For OTP failures, reset state for retry
      requests[requestId].otpRetryCount += 1;
      requests[requestId].errorType = 'INVALID_OTP';
      requests[requestId].otpError = 'The code you entered is not valid. Please check the code and try again.';
      requests[requestId].showOtpModal = true;
      requests[requestId].status = 'waiting_for_2fa';
      
      console.log(`[${requestId}] OTP verification failed (attempt ${requests[requestId].otpRetryCount})`);
      addLog(`OTP verification failed. Please enter the correct code. (Attempt ${requests[requestId].otpRetryCount} of ${requests[requestId].maxOtpRetries})`, null);
    }
  };

  // run background pipeline for this request
  (async () => {
    const cookiesScript = path.join(__dirname, 'generateCookies.py');
    const fetchScript = path.join(__dirname, 'fetchAlexaActivity.py');
    const syncScript = path.join(__dirname, 'SyncAudioTranscripts.py');
    // NEW: Audio download and report generation scripts
    const downloadAudioScript = path.join(__dirname, 'downloadAlexaAudio.py');
    const generateReportScript = path.join(__dirname, 'generateAudioReport.py');
    const hashScript = path.join(__dirname, 'hash.py');
    const jsonPath = path.join(__dirname, '..', 'matched_audio_transcripts.json');
    // NEW: html report path
    const htmlReportPath = path.join(__dirname, '..', 'smart_assistant_report.html');

    const env = { ...process.env, AMAZON_EMAIL: email, AMAZON_PASSWORD: password, REQUEST_ID: requestId };

    try {
      // Step 1: Generating cookies
      requests[requestId].step = 'cookies';
      requests[requestId].status = 'running';
      addLog('Establishing secure connection...', 10);

      // spawn node script (so we can capture exit and not block main thread)
      const child = spawn('python', [cookiesScript], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      
      // Track child process for potential cancellation
      requests[requestId].childProcesses.push(child);

      let cookieOutput = '';
      let cookieError = '';
      
      // FIXED: COMPLETELY REWRITTEN stdout handler with proper OTP state management
      child.stdout.on('data', (d) => {
        const data = d.toString();
        cookieOutput += data;
        
        // Extract and update current URL from cookie script output
        const urlMatch = data.match(/Current URL: (https?:\/\/[^\s]+)/);
        if (urlMatch) {
          updateCurrentUrl(urlMatch[1]);
        }
        
        // FIXED: Process authentication events in order of priority
        if (data.includes('Successfully reached Alexa activity page') || data.includes('Authentication completed successfully')) {
          if (!requests[requestId].authCompleted) {
            updateCurrentUrl('https://www.amazon.in/alexa-privacy/apd/rvh');
            addLog('Authentication completed successfully', 50);
            requests[requestId].authCompleted = true;
            // Clear any OTP error state when auth completes successfully
            requests[requestId].errorType = null;
            requests[requestId].otpError = null;
            requests[requestId].showOtpModal = false;
          }
        }
        // FIXED: OTP SUCCESS must be checked BEFORE OTP failure
        else if (data.includes('OTP authentication completed successfully') || data.includes('OTP verification successful')) {
          handleOtpSuccess();
        }
        // FIXED: Push notification events
        else if (data.includes('Push notification page') && !requests[requestId].authCompleted) {
          addLog('Push notification sent to your device. Please approve to continue...', 40);
        }
        else if (data.includes('Secure connection established') && !requests[requestId].authCompleted) {
          addLog('Secure connection established successfully', 45);
        }
        // FIXED: OTP FAILURE must be checked after success
        else if ((data.includes('OTP verification failed') || data.includes('INVALID_OTP'))) {
          handleOtpFailure();
        }
        // FIXED: Other authentication errors
        else if (data.includes('INVALID_EMAIL')) {
          cancelPipeline('INVALID_EMAIL', 'Invalid email address provided');
          addLog('The email address is not associated with an Amazon account. Please check your email and try again.', null);
          return;
        }
        else if (data.includes('INCORRECT_PASSWORD')) {
          cancelPipeline('INCORRECT_PASSWORD', 'Incorrect password provided');
          addLog('The password is incorrect. Please check your password and try again.', null);
          return;
        }
        else if (data.includes('Push notification was denied')) {
          cancelPipeline('PUSH_DENIED', 'Push notification was denied');
          addLog('Sign in attempt was denied from your device. Please try again and approve the notification.', null);
          return;
        }
        else if (data.includes('UNKNOWN_2FA_PAGE') || data.includes('Unknown 2FA page detected')) {
          cancelPipeline('UNKNOWN_2FA_PAGE', 'Unknown 2FA page detected');
          addLog('This account has been accessed too many times with this account. Please try again tomorrow.', null);
          return;
        }
        else if (data.includes('UNEXPECTED_ERROR') || data.includes('An unexpected error occurred during authentication')) {
          cancelPipeline('GENERIC_ERROR', 'An unexpected error occurred during authentication. Please try again.');
          addLog('An unexpected error occurred during authentication. Please try again.', null);
          return;
        }
      });
      
      child.stderr.on('data', (d) => {
        const errorData = d.toString();
        cookieError += errorData;
        console.error(`[${requestId}] cookies stderr: ${errorData}`);
        
        // FIXED: Same logic for stderr but don't cancel pipeline from stderr alone
        if (errorData.includes('Successfully reached Alexa activity page') || errorData.includes('Authentication completed successfully')) {
          if (!requests[requestId].authCompleted) {
            updateCurrentUrl('https://www.amazon.in/alexa-privacy/apd/rvh');
            addLog('Authentication completed successfully', 50);
            requests[requestId].authCompleted = true;
            requests[requestId].errorType = null;
            requests[requestId].otpError = null;
            requests[requestId].showOtpModal = false;
          }
        }
        else if (errorData.includes('OTP authentication completed successfully') || errorData.includes('OTP verification successful')) {
          handleOtpSuccess();
        }
        else if ((errorData.includes('OTP verification failed') || errorData.includes('INVALID_OTP'))) {
          handleOtpFailure();
        }
      });

      const exitCode = await new Promise((resolve) => child.on('close', resolve));
      
      // Remove child from tracking after it closes
      requests[requestId].childProcesses = requests[requestId].childProcesses.filter(cp => cp !== child);
      
      // FIXED: Simplified pipeline continuation logic
      if (requests[requestId].errorType && 
          ['INVALID_EMAIL', 'INCORRECT_PASSWORD', 'PUSH_DENIED', 'UNKNOWN_2FA_PAGE', 'MAX_OTP_RETRIES_EXCEEDED', 'CANCELLED'].includes(requests[requestId].errorType)) {
        console.log(`[${requestId}] Pipeline cancelled due to error: ${requests[requestId].errorType}`);
        return;
      }
      
      // FIXED: If we're still waiting for OTP (not cancelled), stop the pipeline
      if (requests[requestId].errorType === 'INVALID_OTP') {
        console.log(`[${requestId}] Still waiting for OTP retry, stopping pipeline`);
        return;
      }
      
      // If the cookie script failed and we're not authenticated, throw error
      if (exitCode !== 0 && !requests[requestId].authCompleted && !requests[requestId].errorType) {
        throw new Error(`GenerateAmazonCookie exited with ${exitCode}: ${cookieError}`);
      }
      
      // Ensure we mark authentication as complete if we reached the target page
      if (!requests[requestId].currentUrl?.includes('/alexa-privacy/apd/') && requests[requestId].authCompleted) {
        updateCurrentUrl('https://www.amazon.in/alexa-privacy/apd/rvh');
      }

      // Step 2: fetch Alexa activity - ONLY RUN IF AUTHENTICATION SUCCEEDED
      if (!requests[requestId].errorType && requests[requestId].authCompleted) {
        requests[requestId].step = 'fetch';
        requests[requestId].status = 'running';
        addLog('Starting data extraction from your account... (this may take sometime) ', 55);

        let activityCount = 0;
        const fetchProcess = exec(`python "${fetchScript}"`, { env });

        // Track the actual process with a simple wrapper
        const fetchChild = {
          kill: () => {
            try {
              fetchProcess.kill();
              console.log(`[${requestId}] Killed fetch process`);
            } catch (err) {
              console.warn(`[${requestId}] Error killing fetch process:`, err.message);
            }
          }
        };
        requests[requestId].childProcesses.push(fetchChild);
        
        fetchProcess.stdout.on('data', (data) => {
          const output = data.toString();
          console.log(`[${requestId}] fetchAlexaActivity stdout:`, output);
          
          // Parse activity count from Python script output
          const activityMatch = output.match(/Processing (\d+) to (\d+)/);
          if (activityMatch) {
            const currentCount = parseInt(activityMatch[2]);
            if (currentCount > activityCount) {
              activityCount = currentCount;
              const progress = Math.min(55 + Math.floor((currentCount / 50) * 35), 90); // 55-90% based on activities
              addLog(`Extracted data from ${currentCount} activities so far...`, progress);
            }
          }
          
          // Check for completion
          if (output.includes('PROCESSING COMPLETE') || output.includes('OPTIMIZED EXTRACTION COMPLETE')) {
            const finalMatch = output.match(/Total activities processed: (\d+)/);
            if (finalMatch) {
              activityCount = parseInt(finalMatch[1]);
              addLog(`Successfully extracted data from ${activityCount} activities`, 90);
            }
          }
        });
        
        fetchProcess.stderr.on('data', (data) => {
          console.error(`[${requestId}] fetchAlexaActivity stderr:`, data.toString());
        });

        await new Promise((resolve, reject) => {
          fetchProcess.on('close', (code) => {
            // Remove from tracking
            requests[requestId].childProcesses = requests[requestId].childProcesses.filter(cp => cp !== fetchChild);
            
            if (code === 0) {
              resolve();
            } else {
              reject(new Error(`fetchAlexaActivity exited with code ${code}`));
            }
          });
        });

        // Step 3: Sync transcripts - ONLY RUN IF PREVIOUS STEPS SUCCEEDED
        if (!requests[requestId].errorType) {
          requests[requestId].step = 'sync';
          addLog('Organizing extracted data...', 92);
          
          await new Promise((resolve, reject) => {
            exec(`python "${syncScript}"`, { env }, (err, stdout, stderr) => {
              if (err) {
                console.error(`[${requestId}] sync error:`, err);
                return reject(err);
              }
              console.log(`[${requestId}] SyncAudioTranscripts stdout:`, stdout);
              if (stderr) console.error(`[${requestId}] SyncAudioTranscripts stderr:`, stderr);
              
              // Parse final stats from sync script
              if (stdout.includes('Final mapping saved')) {
                const mappingMatch = stdout.match(/entries: (\d+)\)/);
                if (mappingMatch) {
                  addLog(`Data organization complete (${mappingMatch[1]} entries processed)`, 94);
                }
              }
              resolve();
            });
          });

          // Step 4: Download audio files - ONLY RUN IF PREVIOUS STEPS SUCCEEDED
          if (!requests[requestId].errorType) {
            requests[requestId].step = 'download_audio';
            addLog('Initializing content for offline use...', 95);
            
            await new Promise((resolve, reject) => {
              exec(`python "${downloadAudioScript}"`, { env }, (err, stdout, stderr) => {
                if (err) {
                  console.warn(`[${requestId}] Audio download warning:`, err);
                  // Don't fail the pipeline if audio download has issues
                }
                console.log(`[${requestId}] Audio download output:`, stdout);
                if (stderr) console.error(`[${requestId}] Audio download stderr:`, stderr);
                
                // Parse download results
                if (stdout.includes('Download Summary')) {
                  const successMatch = stdout.match(/ Successful: (\d+)/);
                  const failedMatch = stdout.match(/ Failed: (\d+)/);
                  if (successMatch && failedMatch) {
                    addLog(`Audio download: ${successMatch[1]} successful, ${failedMatch[1]} failed`, 96);
                  }
                }
                resolve();
              });
            });

            // Step 5: Generate comprehensive report - ONLY RUN IF PREVIOUS STEPS SUCCEEDED
            if (!requests[requestId].errorType) {
              requests[requestId].step = 'generate_report';
              addLog('Generating comprehensive HTML report with embedded audio...', 97);
              
              await new Promise((resolve, reject) => {
                exec(`python "${generateReportScript}"`, { env }, (err, stdout, stderr) => {
                  if (err) {
                    console.error(`[${requestId}] Report generation error:`, err);
                    return reject(err);
                  }
                  console.log(`[${requestId}] Report generation output:`, stdout);
                  if (stderr) console.error(`[${requestId}] Report generation stderr:`, stderr);
                  
                  // Check for audio cleanup completion
                  if (stdout.includes('Temporary audio files have been cleaned up')) {
                    addLog('Audio files cleaned up to save storage space', 98);
                  }
                  
                  if (stdout.includes('HTML REPORT GENERATION COMPLETE')) {
                    addLog('Comprehensive HTML report generated with embedded audio!', 99);
                  }
                  resolve();
                });
              });

              // Step 6: hash and prepare final report for download - ONLY RUN IF PREVIOUS STEPS SUCCEEDED
              if (!requests[requestId].errorType) {
                requests[requestId].step = 'hash';
                addLog('Finalizing report package...', 99);
                
                await new Promise((resolve, reject) => {
                  exec(`python "${hashScript}" "${htmlReportPath}"`, { env }, (err, stdout, stderr) => {
                    if (err) {
                      console.warn(`[${requestId}] hash error:`, err);
                      // Don't reject here as hash failure shouldn't stop the download
                    }
                    console.log(`[${requestId}] hash output:`, stdout);
                    resolve();
                  });
                });

                requests[requestId].step = 'completed';
                requests[requestId].filePath = htmlReportPath;
                requests[requestId].done = true;
                requests[requestId].status = 'completed';
                addLog('Data extraction complete! Your comprehensive HTML report with embedded audio is ready for download.', 100);
                
                console.log(`[${requestId}] Pipeline completed successfully with embedded audio report.`);
              }
            }
          }
        }
      }
    } catch (err) {
      console.error(`[${requestId}] Pipeline error:`, err.message || err);
      
      // Don't override specific error types that were already set
      if (!requests[requestId].errorType) {
        requests[requestId].status = 'error';
        
        // Convert technical errors to user-friendly messages
        let userFriendlyMessage = 'An unexpected error occurred. Please try again.';
        
        if (err.message.includes('push notification') || err.message.includes('Push')) {
          userFriendlyMessage = 'Push notification was not approved in time. Please try again and make sure to approve the notification on your device.';
        } else if (err.message.includes('2FA') || err.message.includes('authentication')) {
          userFriendlyMessage = 'Authentication failed. Please check your credentials and try again.';
        } else if (err.message.includes('credentials') || err.message.includes('password') || err.message.includes('email')) {
          userFriendlyMessage = 'Invalid email or password. Please check your credentials and try again.';
        } else if (err.message.includes('timeout') || err.message.includes('timed out')) {
          userFriendlyMessage = 'The request timed out. Please try again.';
        } else if (err.message.includes('network') || err.message.includes('connection')) {
          userFriendlyMessage = 'Network connection error. Please check your internet connection and try again.';
        } else if (err.message.includes('UNEXPECTED_ERROR')) {
          userFriendlyMessage = 'An unexpected error occurred during authentication. Please try again.';
        }
        
        requests[requestId].error = userFriendlyMessage;
        requests[requestId].errorType = 'GENERIC_ERROR';
        
        addLog(userFriendlyMessage, null);
      }
    }
  })();
});

// Frontend polling endpoint for 2FA / progress
app.get('/api/2fa-status/:id', (req, res) => {
  const id = req.params.id;
  const info = requests[id];
  if (!info) return res.status(404).send('Not found');
  
  res.json(info);
});

// FIXED: Frontend sends OTP for a request id with improved state management
app.post('/api/submit-otp/:id', (req, res) => {
  const id = req.params.id;
  const { otp } = req.body;
  const info = requests[id];
  if (!info) return res.status(404).send('Not found');
  
  info.otp = otp;
  info.status = 'otp_submitted';
  info.otpError = null;
  info.showOtpModal = false;
  info.waitingForOtpRetry = false; // FIXED: Clear waiting flag when OTP is submitted
  
  console.log(`[${id}] OTP received from frontend (masked): ${otp ? otp.replace(/\d/g,'*') : ''}`);
  res.json({ ok: true });
});

// Clear OTP for retry
app.post('/api/internal/clear-otp/:id', (req, res) => {
  const id = req.params.id;
  const info = requests[id];
  if (!info) return res.status(404).send('Not found');
  info.otp = null;
  info.otpError = null;
  console.log(`[${id}] OTP cleared for retry`);
  res.json({ ok: true });
});

// Frontend confirms they completed a non-OTP 2FA (user pressed "I completed")
app.post('/api/confirm-2fa/:id', (req, res) => {
  const id = req.params.id;
  const info = requests[id];
  if (!info) return res.status(404).send('Not found');
  info.userConfirmed2FA = true;
  info.status = 'user_confirmed_2fa';
  res.json({ ok: true });
});

// Endpoint to cancel pipeline execution
app.post('/api/cancel-acquisition/:id', async (req, res) => {
  const id = req.params.id;
  const info = requests[id];
  if (!info) return res.status(404).send('Not found');

  console.log(`[${id}] User requested cancellation of pipeline`);

  const cancelPipeline = async (requestId, errorType, errorMessage) => {
    if (requests[requestId]) {
      console.log(`[${requestId}] Cancelling pipeline due to: ${errorType}`);
      
      // Add cancellation log
      if (requests[requestId].logs) {
        requests[requestId].logs.push({
          timestamp: new Date().toISOString(),
          message: 'Data acquisition cancelled by user. Cleaning up...'
        });
      }
      
      // Kill all child processes
      const cleanupPromises = requests[requestId].childProcesses.map(async (child) => {
        try {
          // For spawn processes
          if (child && typeof child.kill === 'function' && child.pid) {
            console.log(`[${requestId}] Terminating spawn process (PID: ${child.pid})...`);
            child.kill('SIGTERM');
            
            return new Promise((resolve) => {
              const timeout = setTimeout(() => {
                if (child.exitCode === null) {
                  child.kill('SIGKILL');
                  console.log(`[${requestId}] Force killed spawn process with SIGKILL`);
                }
                resolve();
              }, 3000);
              
              child.on('exit', () => {
                clearTimeout(timeout);
                console.log(`[${requestId}] Spawn process exited normally`);
                resolve();
              });
            });
          } 
          // For exec processes
          else if (child && typeof child.kill === 'function') {
            console.log(`[${requestId}] Killing exec process...`);
            child.kill();
            console.log(`[${requestId}] Exec process killed`);
            return Promise.resolve();
          } 
          else {
            console.warn(`[${requestId}] Unknown child process type:`, typeof child);
            return Promise.resolve();
          }
        } catch (err) {
          console.warn(`[${requestId}] Error killing child process:`, err.message);
          return Promise.resolve();
        }
      });

      await Promise.all(cleanupPromises);
      
      requests[requestId].childProcesses = [];
      requests[requestId].errorType = errorType;
      requests[requestId].status = 'cancelled';
      requests[requestId].error = errorMessage;
      requests[requestId].done = false;
      
      console.log(`[${requestId}] Pipeline cancelled and cleaned up`);
    }
  };

  await cancelPipeline(id, 'CANCELLED', 'Data acquisition was cancelled by user.');
  res.json({ ok: true, message: 'Pipeline cancelled successfully' });
});

// CRITICAL FIX: Internal endpoint used by the headless node script to set detected method / message
app.post('/api/internal/2fa-update/:id', (req, res) => {
  const id = req.params.id;
  const { method, message, currentUrl, errorType, otpError, showOtpModal } = req.body;
  const info = requests[id];
  if (!info) return res.status(404).send('Not found');
  
  if (method !== undefined && method !== null) {
    info.method = method;
  }
  
  info.message = message || null;
  info.status = 'waiting_for_2fa';
  
  // Add the message as a log entry for the frontend
  if (message && message.trim()) {
    const lastLog = info.logs[info.logs.length - 1];
    if (!lastLog || lastLog.message !== message) {
      info.logs.push({
        timestamp: new Date().toISOString(),
        message: message
      });
      console.log(`[${id}] HTTP LOG: ${message}`);
    }
  }
  
  // FIXED: Improved OTP error handling with retry count tracking
  if (errorType === 'INVALID_OTP') {
    info.errorType = errorType;
    info.showOtpModal = showOtpModal !== undefined ? showOtpModal : true;
    info.otpError = otpError || 'The code you entered is not valid. Please check the code and try again.';
    info.waitingForOtpRetry = true;
    
    // Set method to OTP if not already set
    if (!info.method || !info.method.includes('OTP')) {
      info.method = 'OTP (SMS/Voice)';
    }
  } else if (errorType === 'PUSH_DENIED') {
    info.errorType = errorType;
    info.status = 'error';
    info.error = message || 'Push notification was denied';
    info.showOtpModal = false;
  } else if (errorType === 'UNKNOWN_2FA_PAGE') {
    info.errorType = errorType;
    info.status = 'error';
    info.error = message || 'Unknown 2FA page detected';
    info.showOtpModal = false;
  } else {
    info.showOtpModal = showOtpModal !== undefined ? showOtpModal : (method && method.includes('OTP'));
    info.otpError = null;
  }
  
  if (currentUrl) {
    info.currentUrl = currentUrl;
  }
  
  if (method || errorType || (message && message.includes('2FA') || message.includes('authentication') || message.includes('error'))) {
    console.log(`[${id}] Status update: ${method || ''} ${message || ''} ${errorType || ''}`);
  }
  
  res.json({ ok: true });
});

// Internal endpoint used by headless script to poll for OTP (if frontend submitted)
app.get('/api/internal/get-otp/:id', (req, res) => {
  const id = req.params.id;
  const info = requests[id];
  if (!info) return res.status(404).send('Not found');
  res.json({ 
    otp: info.otp || null, 
    userConfirmed2FA: !!info.userConfirmed2FA,
    showOtpModal: !!info.showOtpModal,
    otpError: info.otpError || null,
    waitingForOtpRetry: !!info.waitingForOtpRetry // FIXED: Include waiting state
  });
});

// Download endpoint once pipeline is complete
app.get('/api/download/:id', (req, res) => {
  const id = req.params.id;
  const info = requests[id];
  if (!info) return res.status(404).send('Not found');
  if (!info.done) return res.status(400).send('Not ready');
  let filePath = info.filePath;
  
  console.log(`[${id}] Download requested, filePath: ${filePath}`);
  
  if (!filePath || !fs.existsSync(filePath)) {
    console.log(`[${id}] File not found at path: ${filePath}`);
    
    const htmlReportPath = path.join(__dirname, '..', 'smart_assistant_report.html');
    if (fs.existsSync(htmlReportPath)) {
      console.log(`[${id}] Serving fallback HTML report`);
      filePath = htmlReportPath;
    } else {
      return res.status(500).send('File not found');
    }
  }
  
  if (filePath.endsWith('.html')) {
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Content-Disposition', 'attachment; filename="smart_assistant_report.html"');
    console.log(`[${id}] Serving HTML report: ${filePath}`);
  } else if (filePath.endsWith('.json')) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="alexa_data.json"');
    console.log(`[${id}] Serving JSON data: ${filePath}`);
  } else {
    const filename = path.basename(filePath);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  }
  
  res.sendFile(filePath, (err) => {
    if (err) {
      console.error(`[${id}] Error sending file:`, err);
      return res.status(500).send('Error sending file');
    }
    
    console.log(`[${id}] File sent successfully`);
  });
});

const PORT = process.env.PORT || 5000;

// Serve frontend build when available (production single-image mode)
const buildPath = path.join(__dirname, '..', 'build');
if (fs.existsSync(buildPath)) {
  app.use(express.static(buildPath));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/artifact') || req.path.startsWith('/artifacts')) return next();
    res.sendFile(path.join(buildPath, 'index.html'));
  });
}

(async () => {
  try {
    const server = app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

    const shutdown = async () => {
      console.log('Shutting down...');
      try {
        if (mongoClient && mongoClient.close) {
          await mongoClient.close();
          console.log('Mongo client closed');
        }
      } catch (e) {
        console.error('Error closing Mongo client:', e);
      }
      server.close(() => {
        console.log('HTTP server closed');
        process.exit(0);
      });
      setTimeout(() => process.exit(1), 10000);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
})();