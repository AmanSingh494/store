"use client";
import { useState, useCallback, useEffect, useRef } from "react";
import { useWebSocket } from "./useWebSocket.js";
import { useAudioRecording } from "./useAudioRecording.js";
import { useAudioPlayback } from "./useAudioPlayback.js";
import { usePerformanceMetrics } from "./usePerformanceMetrics.js";
import { logger } from "../utils/logger.js";

export const useVoiceCall = () => {
  const [callStatus, setCallStatus] = useState("idle");
  const [sttTranscript, setSttTranscript] = useState("");
  const { timestamps, metrics, resetTimestamps, updateTimestamp, calculateMetrics, setTimestamps } =
    usePerformanceMetrics();

  const {
    interruptAudio,
    setupAudio,
    playPCMChunk,
    base64PCMToFloat32,
    binaryPCMToFloat32,
    disconnectAudio,
    decodeOpusPacket,
    saveRawOpusData,
    startAudioCollection,
    processDecodedChunks,
  } = useAudioPlayback();

  const handleWebSocketMessage = useCallback(
    async (message) => {
      if (message.type === "utterance_end") {
        setSttTranscript(message.response);
      }
      // logger.log('Processing message in useVoiceCall:', message)
      if (message instanceof ArrayBuffer) {
        logger.log("🎵 Received binary audio data:", message.byteLength, "bytes");
        // const float32Audio = binaryPCMToFloat32(message)
        // playPCMChunk(float32Audio)
        return;
      }
      // Handle Blob data
      if (message instanceof Blob) {
        logger.log("🎵 Received blob audio data:", message.size, "bytes");
        // const arrayBuffer = await message.arrayBuffer()
        // const float32 = binaryPCMToFloat32(arrayBuffer)
        // playPCMChunk(float32)
        // opus
        const float32Audio = decodeOpusPacket(message);
        processDecodedChunks(float32Audio);
        // saveRawOpusData(message, 'received-opus-data')
        return;
      }
      // Handle different message formats from the backend
      if (message.type === "transcription_response") {
        // Handle user speech transcription from your backend
        const transcript = message.response;
        logger.log("📝 Found transcription_response (user speech):", transcript);
        if (transcript) {
          setSttTranscript(transcript);
          const newEntry = {
            id: Date.now() + Math.random(),
            text: transcript,
            timestamp: new Date().toLocaleTimeString(),
            type: "user",
          };
          logger.log("📝 Adding user message to conversation history:", newEntry);
        }
      } else if (message.type === "ai_response") {
        // Handle AI response from your backend
        const aiResponse = message.response;
        logger.log("🤖 Found ai_response:", aiResponse);
        if (aiResponse) {
          const newEntry = {
            id: Date.now() + Math.random(),
            text: aiResponse,
            timestamp: new Date().toLocaleTimeString(),
            type: "ai",
          };
          logger.log("🤖 Adding AI message to conversation history:", newEntry);
        }
      } else if (message.type === "audio_chunk" && message.data) {
        playPCMChunk(base64PCMToFloat32(message.data));
      } else if (message.type === "audio_interrupt") {
        interruptAudio();
        logger.log("🛑 Audio interrupt received");
        // stopCurrentAudio();
      } else if (message.type === "error") {
        logger.error("WebSocket error message:", message);
        const newEntry = {
          id: Date.now() + Math.random(),
          text: `Error: ${message.message || JSON.stringify(message)}`,
          timestamp: new Date().toLocaleTimeString(),
          type: "error",
        };
        logger.log("❌ Adding error message to conversation history:", newEntry);
      } else {
        // Log unhandled message types for debugging
        logger.log("Unhandled message type:", message.type, message);
      }
    },
    [playPCMChunk, base64PCMToFloat32, interruptAudio, decodeOpusPacket, processDecodedChunks]
  );

  const handleFirstAudioChunk = useCallback(
    (timestamp) => {
      setTimestamps((prev) => {
        if (!prev.firstAudioChunk) {
          const ttsLatency = timestamp - (prev.ttsStart || timestamp);
          console.log(`🎵 First audio chunk in: ${ttsLatency.toFixed(2)}ms`);
          return { ...prev, firstAudioChunk: timestamp };
        }
        return prev;
      });
    },
    [setTimestamps]
  );

  const { wsStatus, wsRef, connectWebSocket, disconnectWebSocket } = useWebSocket({
    onMessage: handleWebSocketMessage,
    onTimestampUpdate: updateTimestamp,
    onResetTimestamps: resetTimestamps,
    timestamps: timestamps,
    setTimestamps: setTimestamps,
  });

  const { micStatus, recordingStatus, startRecording, stopRecording } = useAudioRecording();

  useEffect(() => {
    // console.log(isAiSpeaking, "ai speak");
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          type: "audio_playback_end",
        })
      );
      console.log("Sent audio_playback_end signal to backend.");
    }
  }, [wsRef]);

  const startCall = useCallback(async () => {
    if (callStatus === "connecting" || callStatus === "connected") {
      console.warn("Call is already in progress or connecting.");
      return;
    }

    setCallStatus("connecting");

    try {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
        console.log("Connecting to WebSocket...");
        await connectWebSocket();
        console.log("WebSocket connected successfully!");
      }

      if (recordingStatus !== "recording") {
        console.log("Starting recording...");
        await startRecording(wsRef.current);
      }
      await setupAudio();
      setCallStatus("connected");
      console.log("Call started successfully!");
      return true;
    } catch (error) {
      console.error("Failed to start call:", error);
      setCallStatus("idle");
      alert(`Failed to start call: ${error.message}`);
      return false;
    }
  }, [callStatus, wsRef, connectWebSocket, recordingStatus, startRecording, setupAudio]);

  const stopCall = useCallback(async () => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      disconnectWebSocket();
    } else {
      console.log("WebSocket is not connected, call might have been already stopped.");
    }
    if (recordingStatus === "recording") {
      console.log("Stopping recording...");
      stopRecording();
    }
    if (callStatus !== "idle") {
      setCallStatus("idle");
    }
    disconnectAudio();
    console.log("Call stopped successfully!");
  }, [wsRef, stopRecording, disconnectWebSocket, recordingStatus, callStatus, disconnectAudio]);

  return {
    // States
    callStatus,
    wsStatus,
    micStatus,
    recordingStatus,
    sttTranscript,
    timestamps,
    metrics,

    // Actions
    startCall,
    stopCall,
    resetTimestamps,

    // WebSocket
    wsRef,
  };
};
