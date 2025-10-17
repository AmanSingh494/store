"use client";
import { useRef, useEffect, useCallback } from "react";
import { logger } from "../utils/logger";

export function useAudioPlayback() {
  const audioContextRef = useRef(null);
  const workletNodeRef = useRef(null);
  const chunkQueue = useRef([]);
  const isPlaying = useRef(false);
  const isWorkletConnected = useRef(false);

  // Replace opus decoder with WebCodecs AudioDecoder
  const webCodecsDecoderRef = useRef(null);
  const decodedChunksQueue = useRef([]);

  // Add buffer size tracking (in samples)
  const currentBufferSize = useRef(0);
  const MIN_BUFFER_SAMPLES = 3840; // ~160ms at 24kHz (4 chunks of 960 samples)

  const audioDebugRef = useRef([]);
  const isCollectingAudio = useRef(false);

  const startAudioCollection = useCallback(() => {
    audioDebugRef.current = [];
    isCollectingAudio.current = true;
    logger.log("[AudioDebug] Started collecting audio chunks for this turn");
  }, []);
  // Function to create and connect the AudioContext and WorkletNode
  const setupAudio = useCallback(async () => {
    if (audioContextRef.current) {
      return;
    }

    const ctx = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: 24000,
    });
    audioContextRef.current = ctx;

    if (ctx.state === "suspended") {
      await ctx.resume();
    }
    logger.log("[AudioPlayback] Created and resumed AudioContext.");

    try {
      await ctx.audioWorklet.addModule("/pcm-player-processor.js");
      workletNodeRef.current = new window.AudioWorkletNode(ctx, "pcm-player-processor");
      workletNodeRef.current.connect(ctx.destination);
      isWorkletConnected.current = true;
      logger.log("[AudioPlayback] AudioWorkletNode created and connected.");

      // Set up the message handler for backpressure
      workletNodeRef.current.port.onmessage = (event) => {
        if (event.data && event.data.bufferSpaceAvailable) {
          sendNextChunk();
        }
      };
    } catch (e) {
      logger.error("[AudioPlayback] Error setting up AudioWorklet:", e);
      isWorkletConnected.current = false;
      if (audioContextRef.current) {
        audioContextRef.current.close();
        audioContextRef.current = null;
      }
    }
  }, []);

  // Update processDirectPCM to handle auto-setup
  const processDirectPCM = useCallback(
    async (pcmData) => {
      logger.log(`[AudioPlayback] Processing ${pcmData.length} decoded PCM samples`);

      // Auto-setup audio if not ready
      if (!audioContextRef.current || !workletNodeRef.current || !isWorkletConnected.current) {
        logger.log("[AudioPlayback] Audio system not ready for PCM processing, attempting setup...");

        try {
          await setupAudio();
          logger.log("[AudioPlayback] Audio setup completed for PCM processing");
        } catch (setupError) {
          logger.error("[AudioPlayback] Failed to setup audio for PCM:", setupError);
          return; // Can't process without audio setup
        }
      }

      // Buffer the audio chunks
      if (pcmData.length <= 2048) {
        chunkQueue.current.push(pcmData);
        currentBufferSize.current += pcmData.length;
      } else {
        // Split large arrays into smaller chunks
        const chunkSize = 4096;
        for (let i = 0; i < pcmData.length; i += chunkSize) {
          const chunk = pcmData.subarray(i, i + chunkSize);
          chunkQueue.current.push(chunk);
          currentBufferSize.current += chunk.length;
        }
      }

      const bufferMs = ((currentBufferSize.current / 24000) * 1000).toFixed(0);
      logger.log(`[AudioPlayback] Buffer size: ${currentBufferSize.current} samples (${bufferMs}ms)`);

      // Start playback when we have enough buffered
      if (!isPlaying.current && currentBufferSize.current >= MIN_BUFFER_SAMPLES) {
        logger.log(`[AudioPlayback] Starting playback with ${currentBufferSize.current} samples buffered`);
        isPlaying.current = true;
        sendNextChunk();
      } else if (!isPlaying.current) {
        const requiredMs = ((MIN_BUFFER_SAMPLES / 24000) * 1000).toFixed(0);
        logger.log(`[AudioPlayback] Buffering... ${bufferMs}ms/${requiredMs}ms`);
      }
    },
    [setupAudio]
  );

  // Resample from any rate to 24kHz
  const resampleTo24kHz = useCallback((inputBuffer, inputSampleRate) => {
    if (inputSampleRate === 24000) {
      return inputBuffer;
    }

    const ratio = inputSampleRate / 24000;
    const outputLength = Math.floor(inputBuffer.length / ratio);
    const outputBuffer = new Float32Array(outputLength);

    for (let i = 0; i < outputLength; i++) {
      const inputIndex = i * ratio;
      const index = Math.floor(inputIndex);
      const fraction = inputIndex - index;

      if (index + 1 < inputBuffer.length) {
        // Linear interpolation
        outputBuffer[i] = inputBuffer[index] * (1 - fraction) + inputBuffer[index + 1] * fraction;
      } else {
        outputBuffer[i] = inputBuffer[index] || 0;
      }
    }

    return outputBuffer;
  }, []);

  // Update convertAudioDataToFloat32Array for better resampling
  const convertAudioDataToFloat32Array = useCallback(
    (audioData) => {
      const numberOfFrames = audioData.numberOfFrames;
      const numberOfChannels = audioData.numberOfChannels;
      const sampleRate = audioData.sampleRate;

      logger.log(
        `[AudioPlayback] Converting AudioData: ${numberOfFrames} frames, ${numberOfChannels} ch, ${sampleRate}Hz`
      );

      // Allocate buffer for all channels
      const buffer = new Float32Array(numberOfFrames * numberOfChannels);

      // Copy audio data
      audioData.copyTo(buffer, {
        planeIndex: 0,
        format: "f32",
      });

      // Convert to mono if stereo
      let monoBuffer;
      if (numberOfChannels === 1) {
        monoBuffer = buffer;
      } else {
        // Mix stereo to mono
        monoBuffer = new Float32Array(numberOfFrames);
        for (let i = 0; i < numberOfFrames; i++) {
          let sample = 0;
          for (let ch = 0; ch < numberOfChannels; ch++) {
            sample += buffer[i * numberOfChannels + ch];
          }
          monoBuffer[i] = sample / numberOfChannels;
        }
        logger.log(`[AudioPlayback] Mixed ${numberOfChannels} channels to mono`);
      }

      // ✅ ADD THIS RESAMPLING STEP:
      // if (sampleRate !== 24000) {
      //   logger.log(`[AudioPlayback] Resampling from ${sampleRate}Hz to 24kHz`);
      //   const resampledBuffer = resampleTo24kHz(monoBuffer, sampleRate);
      //   return resampledBuffer;
      // }

      return monoBuffer;
    },
    []
    // [resampleTo24kHz]
  ); // ✅ Add dependency

  const initWebCodecsDecoder = useCallback(async () => {
    if (!webCodecsDecoderRef.current) {
      try {
        logger.log("[AudioPlayback] Initializing WebCodecs AudioDecoder for raw Opus...");

        // Check if WebCodecs is supported
        if (!window.AudioDecoder) {
          throw new Error("WebCodecs AudioDecoder not supported in this browser");
        }

        // Try different configurations to find what works
        const configs = [
          { codec: "opus", sampleRate: 48000, numberOfChannels: 1 }, // Mono
          { codec: "opus", sampleRate: 48000, numberOfChannels: 2 }, // Stereo
          { codec: "opus", sampleRate: 24000, numberOfChannels: 1 }, // Lower sample rate
        ];

        let workingConfig = null;

        for (const config of configs) {
          try {
            logger.log("[AudioPlayback] Testing config:", config);

            // eslint-disable-next-line no-undef
            const support = await AudioDecoder.isConfigSupported(config);
            logger.log("[AudioPlayback] Config support result:", support);

            if (support.supported) {
              workingConfig = config;
              break;
            }
          } catch (configError) {
            logger.warn("[AudioPlayback] Config test failed:", configError);
          }
        }

        if (!workingConfig) {
          throw new Error("No supported Opus configuration found");
        }

        logger.log("[AudioPlayback] Using working config:", workingConfig);

        // Create the decoder with enhanced error handling
        // eslint-disable-next-line no-undef
        webCodecsDecoderRef.current = new AudioDecoder({
          output: (audioData) => {
            try {
              logger.log("[AudioPlayback] ✅ WebCodecs decoded Opus frame successfully:", {
                numberOfFrames: audioData.numberOfFrames,
                numberOfChannels: audioData.numberOfChannels,
                sampleRate: audioData.sampleRate,
                timestamp: audioData.timestamp,
                duration: audioData.duration,
              });

              // Convert AudioData to Float32Array
              const float32Data = convertAudioDataToFloat32Array(audioData);

              // Process immediately since it's already properly formatted
              if (float32Data && float32Data.length > 0) {
                processDirectPCM(float32Data);
              } else {
                logger.warn("[AudioPlayback] Converted audio data is empty");
              }

              // Close the AudioData to free memory
              audioData.close();
            } catch (outputError) {
              logger.error("[AudioPlayback] Error in decoder output handler:", outputError);
              audioData.close();
            }
          },
          error: (error) => {
            logger.error("[AudioPlayback] ❌ WebCodecs decoder error details:", {
              name: error.name,
              message: error.message,
              code: error.code,
              stack: error.stack,
            });

            // Log decoder state when error occurs
            if (webCodecsDecoderRef.current) {
              logger.error("[AudioPlayback] Decoder state during error:", webCodecsDecoderRef.current.state);
            }

            // Reset decoder on error
            webCodecsDecoderRef.current = null;
          },
        });

        logger.log("[AudioPlayback] WebCodecs decoder created, configuring...");

        // Configure the decoder
        webCodecsDecoderRef.current.configure(workingConfig);

        // Wait a bit for configuration
        await new Promise((resolve) => setTimeout(resolve, 50));

        logger.log("[AudioPlayback] WebCodecs decoder configured, final state:", webCodecsDecoderRef.current.state);

        // Verify decoder is ready
        if (webCodecsDecoderRef.current.state !== "configured") {
          throw new Error(`Decoder not configured properly, state: ${webCodecsDecoderRef.current.state}`);
        }

        logger.log("[AudioPlayback] ✅ WebCodecs raw Opus AudioDecoder initialized successfully");
      } catch (error) {
        logger.error("[AudioPlayback] ❌ Failed to initialize WebCodecs decoder:", error);
        webCodecsDecoderRef.current = null;
        throw error;
      }
    }
  }, [processDirectPCM, convertAudioDataToFloat32Array]);

  const validateOpusPacket = useCallback((packetData) => {
    if (packetData.length === 0) {
      return { valid: false, reason: "Empty packet" };
    }

    const tocByte = packetData[0];
    const config = (tocByte >> 3) & 0x1f;
    const stereo = (tocByte & 0x04) !== 0;
    const frameCount = tocByte & 0x03;

    // Log detailed packet info
    const validation = {
      valid: config <= 31,
      reason: config > 31 ? "Invalid config" : "OK",
      size: packetData.length,
      tocByte: `0x${tocByte.toString(16).padStart(2, "0")}`,
      config: config,
      stereo: stereo,
      frameCount: frameCount === 0 ? 1 : frameCount === 3 ? "variable" : frameCount + 1,
      firstFewBytes: Array.from(packetData.slice(0, Math.min(16, packetData.length))).map(
        (b) => `0x${b.toString(16).padStart(2, "0")}`
      ),
    };

    logger.log("[AudioPlayback] Opus packet validation:", validation);
    return validation;
  }, []);
  // Enhanced decode function with detailed logging
  const decodeOpusPacket = useCallback(
    async (opusPacket) => {
      try {
        if (!webCodecsDecoderRef.current) {
          logger.log("[AudioPlayback] Initializing decoder for Opus packet...");
          await initWebCodecsDecoder();
        }

        let packetData;
        if (opusPacket instanceof ArrayBuffer) {
          packetData = new Uint8Array(opusPacket);
        } else if (opusPacket instanceof Blob) {
          const arrayBuffer = await opusPacket.arrayBuffer();
          packetData = new Uint8Array(arrayBuffer);
        } else if (opusPacket instanceof Uint8Array) {
          packetData = opusPacket;
        } else {
          logger.error("[AudioPlayback] Invalid packet type:", typeof opusPacket);
          return;
        }

        // Check decoder state
        if (!webCodecsDecoderRef.current || webCodecsDecoderRef.current.state !== "configured") {
          logger.error(`[AudioPlayback] Decoder not ready, state: ${webCodecsDecoderRef.current?.state || "null"}`);
          return;
        }
        logger.log("[AudioPlayback] Deepgram raw Opus detected, decoding directly...");

        // Validate raw packet
        const validation = validateOpusPacket(packetData);
        if (!validation.valid) {
          logger.error("[AudioPlayback] Invalid raw Opus packet:", validation);
          return;
        }

        const timestamp = performance.now() * 1000;
        // eslint-disable-next-line no-undef
        const encodedChunk = new EncodedAudioChunk({
          type: "key",
          timestamp: timestamp,
          data: packetData.buffer.slice(packetData.byteOffset, packetData.byteOffset + packetData.byteLength),
        });

        webCodecsDecoderRef.current.decode(encodedChunk);
        logger.log("[AudioPlayback] Decoded Deepgram raw Opus packet");
      } catch (error) {
        logger.error("[AudioPlayback] Error in decodeOpusPacket:", error);
        logger.error("[AudioPlayback] Stack trace:", error.stack);
      }
    },
    [initWebCodecsDecoder, validateOpusPacket]
  );

  // Your existing utility functions remain the same
  const int16ToFloat32 = useCallback((int16Array) => {
    const float32 = new Float32Array(int16Array.length);
    for (let i = 0; i < int16Array.length; i++) {
      float32[i] = int16Array[i] / 32768;
    }
    return float32;
  }, []);

  const base64PCMToFloat32 = useCallback(
    (base64) => {
      const binary = atob(base64);
      const len = binary.length / 2;
      const int16 = new Int16Array(len);
      for (let i = 0; i < len; i++) {
        int16[i] = (binary.charCodeAt(i * 2 + 1) << 8) | binary.charCodeAt(i * 2);
      }
      return int16ToFloat32(int16);
    },
    [int16ToFloat32]
  );
  // Update playPCMChunk to handle raw Opus
  const playPCMChunk = useCallback(
    async (audioData) => {
      // Auto-setup audio if not ready
      if (!audioContextRef.current || !workletNodeRef.current) {
        logger.log("[AudioPlayback] Audio not set up, initializing...");
        try {
          await setupAudio();
        } catch (error) {
          logger.error("[AudioPlayback] Failed to setup audio:", error);
          return;
        }
      }

      if (!isWorkletConnected.current) {
        logger.warn("[AudioPlayback] Worklet is not connected. Call resumeAfterInterrupt() first.");
        return;
      }

      let pcmFloat32Array;

      // Handle different input types
      if (audioData instanceof Float32Array) {
        // Direct Float32 audio - already in correct format
        pcmFloat32Array = audioData;
        logger.log("[AudioPlayback] Processing Float32Array directly");
      } else if (audioData instanceof ArrayBuffer || audioData instanceof Blob || audioData instanceof Uint8Array) {
        // Raw Opus-encoded data - decode it using WebCodecs
        logger.log("[AudioPlayback] Decoding raw Opus data with WebCodecs...");
        await decodeOpusPacket(audioData);

        // WebCodecs processing is async, so we return here
        // The decoded audio will be processed through the decoder callback
        return;
      } else if (typeof audioData === "string") {
        // Base64 PCM data
        logger.log("[AudioPlayback] Processing base64 PCM data");
        pcmFloat32Array = base64PCMToFloat32(audioData);
      } else {
        logger.warn("[AudioPlayback] Invalid audio data type:", typeof audioData);
        return;
      }

      if (!pcmFloat32Array || pcmFloat32Array.length === 0) {
        logger.warn("[AudioPlayback] Received empty or invalid audio data");
        return;
      }

      logger.log(`[AudioPlayback] ${pcmFloat32Array.length} PCM samples received for playbook`);

      // Buffer the audio chunks
      if (pcmFloat32Array.length <= 2048) {
        chunkQueue.current.push(pcmFloat32Array);
        currentBufferSize.current += pcmFloat32Array.length;
      } else {
        // Split large arrays into smaller chunks
        const chunkSize = 4096;
        for (let i = 0; i < pcmFloat32Array.length; i += chunkSize) {
          const chunk = pcmFloat32Array.subarray(i, i + chunkSize);
          chunkQueue.current.push(chunk);
          currentBufferSize.current += chunk.length;
        }
      }

      const bufferMs = ((currentBufferSize.current / 24000) * 1000).toFixed(0);
      logger.log(`[AudioPlayback] Buffer size: ${currentBufferSize.current} samples (${bufferMs}ms)`);

      // Start playback when we have enough buffered
      if (!isPlaying.current && currentBufferSize.current >= MIN_BUFFER_SAMPLES) {
        logger.log(`[AudioPlayback] Starting playback with ${currentBufferSize.current} samples buffered`);
        isPlaying.current = true;
        sendNextChunk();
      } else if (!isPlaying.current) {
        const requiredMs = ((MIN_BUFFER_SAMPLES / 24000) * 1000).toFixed(0);
        logger.log(`[AudioPlayback] Buffering... ${bufferMs}ms/${requiredMs}ms`);
      }
    },
    [decodeOpusPacket, setupAudio, base64PCMToFloat32]
  );

  // Process decoded chunks from WebCodecs
  const processDecodedChunks = useCallback(() => {
    while (decodedChunksQueue.current.length > 0) {
      const decodedChunk = decodedChunksQueue.current.shift();

      if (decodedChunk && decodedChunk.length > 0) {
        // Add to playback queue
        playPCMChunk(decodedChunk);
      }
    }
  }, [playPCMChunk]);

  // Clean up WebCodecs decoder
  const cleanupWebCodecsDecoder = useCallback(() => {
    if (webCodecsDecoderRef.current) {
      try {
        webCodecsDecoderRef.current.close();
        logger.log("[AudioPlayback] WebCodecs decoder closed");
      } catch (error) {
        logger.warn("[AudioPlayback] Error closing WebCodecs decoder:", error);
      }
      webCodecsDecoderRef.current = null;
    }

    // Clear decoded chunks queue
    decodedChunksQueue.current = [];
  }, []);

  // Updated disconnect function
  const disconnectAudio = useCallback(() => {
    logger.log("[AudioPlayback] Disconnecting audio due to call cut.");

    try {
      // Stop any ongoing playback immediately
      isPlaying.current = false;
      currentBufferSize.current = 0;

      // Clear all queued chunks
      chunkQueue.current = [];

      // Clean up WebCodecs decoder
      cleanupWebCodecsDecoder();

      // Disconnect and clean up worklet node
      if (workletNodeRef.current) {
        try {
          workletNodeRef.current.disconnect();
          workletNodeRef.current.port.onmessage = null;
        } catch (e) {
          logger.warn("[AudioPlayback] Error disconnecting worklet:", e);
        }
        workletNodeRef.current = null;
      }

      isWorkletConnected.current = false;

      if (audioContextRef.current) {
        audioContextRef.current
          .close()
          .then(() => {
            logger.log("[AudioPlayback] AudioContext closed successfully.");
          })
          .catch((e) => {
            logger.warn("[AudioPlayback] Error closing AudioContext:", e);
          });
        audioContextRef.current = null;
      }

      logger.log("[AudioPlayback] Audio disconnected and resources cleaned up.");
    } catch (error) {
      logger.error("[AudioPlayback] Error during audio disconnection:", error);
    }
  }, [cleanupWebCodecsDecoder]);

  // Function to send the next chunk from the queue
  const sendNextChunk = () => {
    if (!isWorkletConnected.current || !workletNodeRef.current) {
      logger.warn("[AudioPlayback] Cannot send chunk - worklet not connected.");
      isPlaying.current = false;
      return;
    }

    if (chunkQueue.current.length > 0) {
      const nextChunk = chunkQueue.current.shift();
      currentBufferSize.current -= nextChunk.length;
      workletNodeRef.current.port.postMessage({ samples: nextChunk });
    } else {
      isPlaying.current = false;
      currentBufferSize.current = 0;
    }
  };

  const interruptAudio = async () => {
    if (workletNodeRef.current && audioContextRef.current && isWorkletConnected.current) {
      // Disconnect completely
      workletNodeRef.current.disconnect();
      isWorkletConnected.current = false;
      // Clear remaining chunks and reset buffer size
      chunkQueue.current = [];
      currentBufferSize.current = 0;
      isPlaying.current = false;
      logger.log("[AudioPlayback] Audio interrupted - disconnected and queue cleared.");

      // Auto-reconnect for next turn
      try {
        workletNodeRef.current.connect(audioContextRef.current.destination);
        isWorkletConnected.current = true;
        logger.log("[AudioPlayback] Audio automatically reconnected for next turn.");
      } catch (e) {
        logger.error("[AudioPlayback] Error auto-reconnecting worklet:", e);
        await setupAudio();
      }
    }
  };

  const resumeAfterInterrupt = () => {
    if (workletNodeRef.current && audioContextRef.current && !isWorkletConnected.current) {
      try {
        workletNodeRef.current.connect(audioContextRef.current.destination);
        isWorkletConnected.current = true;
        logger.log("[AudioPlayback] Audio reconnected for next turn.");
        return true;
      } catch (e) {
        logger.error("[AudioPlayback] Error reconnecting worklet:", e);
        isWorkletConnected.current = false;
        return false;
      }
    }
    return isWorkletConnected.current;
  };

  // Cleanup effect
  useEffect(() => {
    return () => {
      logger.log("[AudioPlayback] Cleanup on unmount.");
      disconnectAudio();
    };
  }, [disconnectAudio]);

  const binaryPCMToFloat32 = (arrayBuffer) => {
    if (!(arrayBuffer instanceof ArrayBuffer)) {
      logger.warn("[AudioPlayback] Invalid input: not an ArrayBuffer.");
      return new Float32Array(0);
    }

    if (arrayBuffer.byteLength % 2 !== 0) {
      logger.warn(
        "[AudioPlayback] ArrayBuffer size not multiple of 2, cannot create Int16Array. Size:",
        arrayBuffer.byteLength
      );
      return new Float32Array(0);
    }

    try {
      const int16View = new Int16Array(arrayBuffer);
      const float32 = new Float32Array(int16View.length);

      for (let i = 0; i < int16View.length; i++) {
        float32[i] = int16View[i] / 32768;
      }

      logger.log(`[AudioPlayback] Converted binary to Float32Array of length: ${float32.length}`);
      return float32;
    } catch (error) {
      logger.error("[AudioPlayback] Error converting binary PCM to Float32:", error);
      return new Float32Array(0);
    }
  };

  return {
    interruptAudio,
    setupAudio,
    playPCMChunk,
    int16ToFloat32,
    binaryPCMToFloat32,
    base64PCMToFloat32,
    disconnectAudio,
    decodeOpusPacket, // Now uses WebCodecs
    startAudioCollection,
    resumeAfterInterrupt,
    processDecodedChunks,
  };
}
