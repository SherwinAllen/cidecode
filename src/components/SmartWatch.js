import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Link } from 'react-router-dom';

import { motion } from 'framer-motion';
import { 
  containerStyle,
  pageContentStyle,
  fancyHeadingStyle
} from '../constants/styles';

const SmartWatch = () => {
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState(null);
  const [artifacts, setArtifacts] = useState({});
  const [selectedArtifact, setSelectedArtifact] = useState(null);
  const [artifactText, setArtifactText] = useState('');
  const [statusMessage, setStatusMessage] = useState('');

  // 👉 New filesystem states
  const [showFilesystem, setShowFilesystem] = useState(false);
  const [filesystem, setFilesystem] = useState(null);
  const [fsLoading, setFsLoading] = useState(false);

  const navigate = useNavigate();

  useEffect(() => {
    const timer = setTimeout(() => setLoading(false), 2000);
    return () => clearTimeout(timer);
  }, []);

  // ============================
  // 🧩 Acquire Smartwatch Data
  // ============================
  const handleAcquireData = async () => {
    setDownloading(true);
    setError(null);
    setArtifacts({});
    setSelectedArtifact(null);
    setArtifactText('');
    try {
      const queryParams = new URLSearchParams({ source: 'SmartWatch' });
      const response = await fetch(`http://localhost:5000/api/packet-report?${queryParams.toString()}`);
      if (!response.ok) throw new Error(`Failed to fetch data: ${response.statusText}`);
      
      const data = await response.json();
      if (!data.success) throw new Error('Acquisition failed');
      setArtifacts(data.artifacts || {});
      setStatusMessage(data.message || "Preliminary forensic summary generated successfully!");
      setTimeout(() => setStatusMessage(""), 4000);
    } catch (err) {
      setError(err.message);
    } finally {
      setDownloading(false);
    }
  };

  // ============================
  // 🧩 NEW: Fetch File System
  // ============================
  const handleShowFileSystem = async () => {
    setShowFilesystem(true);
    setFsLoading(true);
    setError(null);

    try {
      const res = await fetch("http://localhost:5000/api/filesystem");
      if (!res.ok) throw new Error(`Failed to fetch filesystem: ${res.statusText}`);
      const data = await res.json();
      setFilesystem(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setFsLoading(false);
    }
  };

  // ============================
  // 🧩 File System Renderer
  // ============================
  const renderFileTree = (node, depth = 0) => {
    if (!node) return null;
    const indent = { marginLeft: `${depth * 20}px` };

    return (
      <div style={indent} key={node.name}>
        <p style={{ color: node.type === 'directory' ? '#0f0' : '#fff', cursor: 'pointer' }}>
          {node.type === 'directory' ? '📁' : '📄'} {node.name}
        </p>
        {node.children && node.children.map(child => renderFileTree(child, depth + 1))}
      </div>
    );
  };

  // ============================
  // 🧩 Download Artifact
  // ============================
  const handleDownloadArtifact = async (artifactName) => {
    try {
      const response = await fetch(`http://localhost:5000/artifact/download/${artifactName}`);
      if (!response.ok) throw new Error('Failed to download file.');

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = artifactName; 
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      alert(`Error downloading ${artifactName}: ${err.message}`);
    }
  };

  // ============================
  // 🧩 Styles
  // ============================
  const bigButtonStyle = {
    width: '80%',
    padding: '20px',
    backgroundColor: '#0f0',
    border: 'none',
    color: '#000',
    cursor: 'pointer',
    fontSize: '1.5rem',
    borderRadius: '10px',
    margin: '20px auto',
    display: 'block',
    fontFamily: "'Orbitron', sans-serif",
    textTransform: 'uppercase',
    boxShadow: '0 0 20px rgba(0,255,0,0.7)',
    transition: 'transform 0.2s ease-in-out, box-shadow 0.2s ease-in-out'
  };

  const bigButtonHover = {
    scale: 1.1,
    boxShadow: '0 0 30px rgba(0,255,0,1)'
  };

  return (
    <div
      style={{
        ...containerStyle,
        minHeight: '100vh',
        overflowY: 'auto',
        overflowX: 'hidden'
      }}
    >
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        style={{ ...pageContentStyle, paddingBottom: '80px' }}
      >
        <h1 style={{ ...fancyHeadingStyle, fontSize: '2.5rem', marginBottom: '48px' }}>
          SMART WATCH DATA
        </h1>

        {error && (
          <p style={{ color: 'red', fontSize: '1.2rem', textAlign: 'center' }}>{error}</p>
        )}

        {/* Main Buttons */}
        <motion.button
          onClick={handleAcquireData}
          style={bigButtonStyle}
          whileHover={bigButtonHover}
          disabled={downloading}
        >
          {downloading ? 'Acquiring Data...' : 'Acquire Data'}
        </motion.button>

        <motion.button
          onClick={() => navigate('/iotextractor')}
          style={bigButtonStyle}
          whileHover={bigButtonHover}
        >
          Back to Devices
        </motion.button>

        {/* 🌳 New Button for Filesystem */}
        <Link to="/filesystem" style={{ textDecoration: 'none' }}>
          <motion.button
            // onClick={handleShowFileSystem}
            style={bigButtonStyle}
            whileHover={bigButtonHover}
            disabled={fsLoading}
          >
            {fsLoading ? 'Loading File System...' : 'Show File System'}
          </motion.button>
        </Link>
        {statusMessage && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            style={{
              backgroundColor: 'rgba(0, 255, 0, 0.1)',
              border: '1px solid #0f0',
              color: 'rgba(76, 145, 231, 1)',
              padding: '15px 20px',
              borderRadius: '8px',
              fontFamily: "'Orbitron', sans-serif",
              textAlign: 'center',
              marginBottom: '25px',
              boxShadow: '0 0 15px rgba(0,255,0,0.6)',
              width: '80%',
              marginLeft: 'auto',
              marginRight: 'auto',
            }}
          >
            {statusMessage}
          </motion.div>
        )}

        {/* Existing Artifacts Section */}
        {Object.keys(artifacts).length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', marginTop: '30px', padding: '0 20px' }}>
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                width: '25%',
                gap: '10px',
                overflowY: 'auto',
                maxHeight: '70vh'
              }}
            >
              <h2 style={{ color: '#0f0' }}>Extracted Artifacts</h2>
              {Object.keys(artifacts).map((key) => (
                <div key={key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <motion.button
                    onClick={() => {
                      if (selectedArtifact === key) {
                        setSelectedArtifact(null);
                        setArtifactText('');
                      } else {
                        setSelectedArtifact(key);
                        setArtifactText(artifacts[key]);
                      }
                    }}
                    style={{
                      flex: 1,
                      padding: '8px 12px',
                      backgroundColor: selectedArtifact === key ? '#0f0' : 'transparent',
                      border: '1px solid #0f0',
                      borderRadius: '5px',
                      cursor: 'pointer',
                      fontSize: '0.9rem',
                      fontFamily: "'Orbitron', sans-serif",
                      color: selectedArtifact === key ? '#000' : '#0f0',
                      textAlign: 'left'
                    }}
                    whileHover={{ scale: 1.05 }}
                  >
                    {key.replace(/_/g, ' ')}
                  </motion.button>

                  {selectedArtifact !== key && (
                    <motion.button
                      onClick={() => handleDownloadArtifact(key)}
                      style={{
                        padding: '6px 10px',
                        backgroundColor: '#0f0',
                        color: '#000',
                        border: 'none',
                        borderRadius: '5px',
                        cursor: 'pointer',
                        fontSize: '0.8rem',
                        fontFamily: "'Orbitron', sans-serif"
                      }}
                      whileHover={{ scale: 1.05 }}
                    >
                      ⬇ Download
                    </motion.button>
                  )}
                </div>
              ))}
            </div>

            <div
              style={{
                flex: 1,
                marginLeft: '30px',
                background: 'rgba(0, 255, 0, 0.05)',
                border: '1px solid #0f0',
                borderRadius: '10px',
                padding: '20px',
                color: '#fff',
                whiteSpace: 'pre-wrap',
                minHeight: '400px',
                maxHeight: '70vh',
                overflowY: 'auto',
              }}
            >
              {selectedArtifact ? (
                <>
                  <h3 style={{ color: '#0f0' }}>{selectedArtifact.replace(/_/g, ' ')}</h3>
                  <p style={{ fontFamily: 'monospace' }}>{artifactText}</p>
                </>
              ) : (
                <p style={{ color: '#0f0', opacity: 0.7 }}>Select an artifact to view its contents.</p>
              )}
            </div>
          </div>
        )}

        {/* 🌳 Filesystem Display */}
        {showFilesystem && (
          <div
            style={{
              marginTop: '50px',
              background: 'rgba(0, 255, 0, 0.05)',
              border: '1px solid #0f0',
              borderRadius: '10px',
              padding: '20px',
              color: '#fff',
              fontFamily: 'monospace',
              maxHeight: '70vh',
              overflowY: 'auto'
            }}
          >
            <h2 style={{ color: '#0f0' }}>Filesystem Structure</h2>
            {fsLoading ? <p>Loading...</p> : renderFileTree(filesystem)}
          </div>
        )}
      </motion.div>
    </div>
  );
};

export default SmartWatch;
