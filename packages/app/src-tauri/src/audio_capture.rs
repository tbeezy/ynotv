//! WASAPI Per-Process Audio Loopback Capture & Real-time FFT Engine
//!
//! Captures PCM audio output specifically from MPV (or system fallback) on Windows
//! using process-specific loopback (Windows 10 2004+ AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK).
//! Performs 1024-point FFT using rustfft and emits frequency spectrum bins, waveform,
//! and stereo L/R channel samples to the frontend at ~60 FPS.

use serde::Serialize;
use std::sync::{
    atomic::{AtomicBool, AtomicU32, Ordering},
    Arc, Mutex,
};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Runtime};

#[derive(Serialize, Clone, Debug)]
pub struct AudioSpectrumData {
    pub bins: Vec<f32>,      // 64 logarithmic frequency bins [0.0..1.0]
    pub wave: Vec<f32>,      // 64 time-domain waveform samples [-1.0..1.0]
    pub stereo_l: Vec<f32>,  // 64 left channel samples [-1.0..1.0]
    pub stereo_r: Vec<f32>,  // 64 right channel samples [-1.0..1.0]
}

pub struct AudioCaptureState {
    pub is_running: Arc<AtomicBool>,
    pub target_pid: Arc<AtomicU32>,
    pub capture_thread: Mutex<Option<std::thread::JoinHandle<()>>>,
}

impl AudioCaptureState {
    pub fn new() -> Self {
        Self {
            is_running: Arc::new(AtomicBool::new(false)),
            target_pid: Arc::new(AtomicU32::new(0)),
            capture_thread: Mutex::new(None),
        }
    }

    pub fn start<R: Runtime>(&self, app: AppHandle<R>, pid: u32) {
        log::info!("[AudioCapture] Requesting capture start for PID={}", pid);

        // Stop any running capture thread
        self.stop();

        self.is_running.store(true, Ordering::SeqCst);
        self.target_pid.store(pid, Ordering::SeqCst);

        let is_running = Arc::clone(&self.is_running);
        let target_pid = pid;

        let handle = std::thread::spawn(move || {
            run_capture_loop(app, is_running, target_pid);
        });

        *self.capture_thread.lock().unwrap() = Some(handle);
    }

    pub fn stop(&self) {
        if self.is_running.load(Ordering::SeqCst) {
            log::info!("[AudioCapture] Stopping audio capture loop...");
            self.is_running.store(false, Ordering::SeqCst);
        }
        if let Some(handle) = self.capture_thread.lock().unwrap().take() {
            let _ = handle.join();
        }
    }
}

#[cfg(target_os = "windows")]
fn run_capture_loop<R: Runtime>(app: AppHandle<R>, is_running: Arc<AtomicBool>, pid: u32) {
    use rustfft::{num_complex::Complex, FftPlanner};
    use windows::Win32::Media::Audio::*;
    use windows::Win32::System::Com::*;

    log::info!("[AudioCapture] Initializing Windows capture thread (PID={})", pid);

    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }

    // Try per-process WASAPI loopback first if PID > 0
    let mut audio_client: Option<IAudioClient> = None;

    if pid > 0 {
        log::info!("[AudioCapture] Attempting per-process WASAPI loopback for PID={}", pid);
        audio_client = activate_process_loopback(pid).ok();
        if audio_client.is_some() {
            log::info!("[AudioCapture] Per-process loopback activated successfully for PID={}", pid);
        } else {
            log::warn!("[AudioCapture] Per-process WASAPI activation failed; falling back to default render device loopback");
        }
    }

    // Fallback to default render device loopback
    if audio_client.is_none() {
        audio_client = activate_default_loopback().ok();
    }

    let client = match audio_client {
        Some(c) => c,
        None => {
            log::error!("[AudioCapture] Could not initialize any WASAPI audio capture device");
            unsafe { CoUninitialize() };
            return;
        }
    };

    // Get format and initialize client
    let pwfx: *mut WAVEFORMATEX = match unsafe { client.GetMixFormat() } {
        Ok(f) => f,
        Err(e) => {
            log::error!("[AudioCapture] GetMixFormat failed: {:?}", e);
            unsafe { CoUninitialize() };
            return;
        }
    };

    let format = unsafe { *pwfx };
    let channels = format.nChannels as usize;
    let bits_per_sample = format.wBitsPerSample;
    let sample_rate = format.nSamplesPerSec as f32;
    let format_tag = format.wFormatTag;

    log::info!(
        "[AudioCapture] Audio Format: {} channels, {} Hz, {} bits/sample, format_tag=0x{:X}",
        channels,
        sample_rate,
        bits_per_sample,
        format_tag
    );

    // Initialize Audio Client for Loopback (100ms buffer)
    unsafe {
        if let Err(e) = client.Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_LOOPBACK,
            1_000_000,
            0,
            pwfx,
            None,
        ) {
            log::error!("[AudioCapture] IAudioClient::Initialize failed: {:?}", e);
            CoTaskMemFree(Some(pwfx as *const _));
            CoUninitialize();
            return;
        }
        CoTaskMemFree(Some(pwfx as *const _));
    }

    let capture_client: IAudioCaptureClient = match unsafe { client.GetService() } {
        Ok(cc) => cc,
        Err(e) => {
            log::error!("[AudioCapture] GetService<IAudioCaptureClient> failed: {:?}", e);
            unsafe { CoUninitialize() };
            return;
        }
    };

    unsafe {
        if let Err(e) = client.Start() {
            log::error!("[AudioCapture] IAudioClient::Start failed: {:?}", e);
            CoUninitialize();
            return;
        }
    }

    // Buffers for FFT & Waveform processing
    const FFT_SIZE: usize = 1024;
    const NUM_BINS: usize = 64;

    let mut pcm_mono_buffer: Vec<f32> = Vec::with_capacity(FFT_SIZE * 2);
    let mut stereo_l_buffer: Vec<f32> = Vec::with_capacity(NUM_BINS * 2);
    let mut stereo_r_buffer: Vec<f32> = Vec::with_capacity(NUM_BINS * 2);

    let mut planner = FftPlanner::new();
    let fft = planner.plan_fft_forward(FFT_SIZE);

    let frame_interval = Duration::from_millis(16); // ~60 FPS
    let mut last_emit = std::time::Instant::now();

    while is_running.load(Ordering::Relaxed) {
        let packet_size = match unsafe { capture_client.GetNextPacketSize() } {
            Ok(size) => size,
            Err(_) => {
                std::thread::sleep(Duration::from_millis(5));
                continue;
            }
        };

        let mut current_packet = packet_size;
        while current_packet > 0 && is_running.load(Ordering::Relaxed) {
            let mut p_data: *mut u8 = std::ptr::null_mut();
            let mut num_frames: u32 = 0;
            let mut flags: u32 = 0;
            let mut device_pos: u64 = 0;
            let mut qpc_pos: u64 = 0;

            let res = unsafe {
                capture_client.GetBuffer(
                    &mut p_data,
                    &mut num_frames,
                    &mut flags,
                    Some(&mut device_pos),
                    Some(&mut qpc_pos),
                )
            };

            if res.is_ok() && num_frames > 0 && !p_data.is_null() {
                let is_silent = (flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0;

                if is_silent {
                    for _ in 0..num_frames {
                        pcm_mono_buffer.push(0.0);
                        stereo_l_buffer.push(0.0);
                        stereo_r_buffer.push(0.0);
                    }
                } else {
                    if bits_per_sample == 32 {
                        let samples = unsafe {
                            std::slice::from_raw_parts(
                                p_data as *const f32,
                                (num_frames as usize) * channels,
                            )
                        };
                        for frame in samples.chunks(channels) {
                            let l = frame.first().copied().unwrap_or(0.0);
                            let r = frame.get(1).copied().unwrap_or(l);
                            let mono = (l + r) * 0.5;

                            pcm_mono_buffer.push(mono);
                            stereo_l_buffer.push(l);
                            stereo_r_buffer.push(r);
                        }
                    } else if bits_per_sample == 16 {
                        let samples = unsafe {
                            std::slice::from_raw_parts(
                                p_data as *const i16,
                                (num_frames as usize) * channels,
                            )
                        };
                        for frame in samples.chunks(channels) {
                            let l = (frame.first().copied().unwrap_or(0) as f32) / 32768.0;
                            let r = (frame.get(1).copied().unwrap_or(0) as f32) / 32768.0;
                            let mono = (l + r) * 0.5;

                            pcm_mono_buffer.push(mono);
                            stereo_l_buffer.push(l);
                            stereo_r_buffer.push(r);
                        }
                    }
                }

                unsafe {
                    let _ = capture_client.ReleaseBuffer(num_frames);
                }
            }

            current_packet = unsafe { capture_client.GetNextPacketSize() }.unwrap_or(0);
        }

        // Keep rolling buffer sizes bounded
        if pcm_mono_buffer.len() > FFT_SIZE * 4 {
            let drain_len = pcm_mono_buffer.len() - FFT_SIZE;
            pcm_mono_buffer.drain(0..drain_len);
        }
        if stereo_l_buffer.len() > NUM_BINS * 4 {
            let drain_len = stereo_l_buffer.len() - NUM_BINS;
            stereo_l_buffer.drain(0..drain_len);
            stereo_r_buffer.drain(0..drain_len);
        }

        // Emit frame at ~60 FPS tick
        if last_emit.elapsed() >= frame_interval && pcm_mono_buffer.len() >= FFT_SIZE {
            last_emit = std::time::Instant::now();

            let sample_slice = &pcm_mono_buffer[pcm_mono_buffer.len() - FFT_SIZE..];

            // 1. Hann Window + FFT
            let mut complex_buffer: Vec<Complex<f32>> = sample_slice
                .iter()
                .enumerate()
                .map(|(i, &s)| {
                    let window = 0.5 * (1.0 - (2.0 * std::f32::consts::PI * i as f32 / (FFT_SIZE - 1) as f32).cos());
                    Complex::new(s * window, 0.0)
                })
                .collect();

            fft.process(&mut complex_buffer);

            // 2. Compute 64 Log-Spaced Frequency Bins (30 Hz to 14 kHz) with dB scaling & per-bar AGC
            let mut bins = vec![0.0f32; NUM_BINS];
            let bin_resolution = sample_rate / (FFT_SIZE as f32); // e.g. 46.875 Hz/bin

            for i in 0..NUM_BINS {
                // Logarithmic frequency bounds (30 Hz to 14,000 Hz)
                let f_start = 30.0 * (14000.0 / 30.0f32).powf(i as f32 / NUM_BINS as f32);
                let f_end = 30.0 * (14000.0 / 30.0f32).powf((i + 1) as f32 / NUM_BINS as f32);

                // Exclude k=0 (DC offset) entirely; k_start >= 1
                let k_start = ((f_start / bin_resolution).floor() as usize).clamp(1, (FFT_SIZE / 2) - 1);
                let k_end = ((f_end / bin_resolution).ceil() as usize).clamp(k_start + 1, FFT_SIZE / 2);

                let mut max_mag = 0.0f32;
                for k in k_start..k_end {
                    let mag = complex_buffer[k].norm() / (FFT_SIZE as f32);
                    if mag > max_mag {
                        max_mag = mag;
                    }
                }

                // Convert linear magnitude -> decibel scale (dBFS)
                let db = 20.0 * (max_mag + 1e-6).log10();

                // High-frequency tilt addition in dB space (+0 dB at sub-bass up to +10 dB at 14 kHz)
                let tilt_db = (i as f32 / (NUM_BINS - 1) as f32) * 10.0;
                let total_db = db + tilt_db;

                // Map [-65.0 dB, 0.0 dB] -> [0.0, 1.0]
                let raw_norm = ((total_db - (-65.0)) / 65.0).clamp(0.0, 1.0);

                // Apply power curve (1.5) so soft audio stays subtle and peaks hit gracefully without maxing out
                let normalized = raw_norm.powf(1.5);

                bins[i] = normalized;
            }

            // 3. Time-Domain Waveform (64 samples)
            let wave_slice = &pcm_mono_buffer[pcm_mono_buffer.len() - NUM_BINS..];
            let wave = wave_slice.to_vec();

            // 4. Stereo L/R Samples (64 samples each)
            let l_start = stereo_l_buffer.len().saturating_sub(NUM_BINS);
            let stereo_l = stereo_l_buffer[l_start..].to_vec();
            let stereo_r = stereo_r_buffer[l_start..].to_vec();

            let payload = AudioSpectrumData {
                bins,
                wave,
                stereo_l,
                stereo_r,
            };
            let _ = app.emit("audio-spectrum-data", payload);
        }

        std::thread::sleep(Duration::from_millis(5));
    }

    unsafe {
        let _ = client.Stop();
        CoUninitialize();
    }
    log::info!("[AudioCapture] Audio capture loop ended cleanly");
}

#[cfg(not(target_os = "windows"))]
fn run_capture_loop<R: Runtime>(_app: AppHandle<R>, _is_running: Arc<AtomicBool>, _pid: u32) {
    log::info!("[AudioCapture] Audio capture is non-Windows stub");
}

// C-compatible COM vtable for IActivateAudioInterfaceCompletionHandler
#[cfg(target_os = "windows")]
#[repr(C)]
struct CompletionHandlerVtbl {
    pub QueryInterface: unsafe extern "system" fn(
        this: *mut std::ffi::c_void,
        riid: *const windows::core::GUID,
        ppvObject: *mut *mut std::ffi::c_void,
    ) -> windows::core::HRESULT,
    pub AddRef: unsafe extern "system" fn(this: *mut std::ffi::c_void) -> u32,
    pub Release: unsafe extern "system" fn(this: *mut std::ffi::c_void) -> u32,
    pub ActivateCompleted: unsafe extern "system" fn(
        this: *mut std::ffi::c_void,
        activateOperation: *mut std::ffi::c_void,
    ) -> windows::core::HRESULT,
}

#[cfg(target_os = "windows")]
#[repr(C)]
struct CompletionHandlerObj {
    pub vtbl: *const CompletionHandlerVtbl,
    pub ref_count: std::sync::atomic::AtomicU32,
    pub sender: Mutex<Option<std::sync::mpsc::Sender<Result<windows::Win32::Media::Audio::IAudioClient, String>>>>,
}

#[cfg(target_os = "windows")]
static COMPLETION_HANDLER_VTBL: CompletionHandlerVtbl = CompletionHandlerVtbl {
    QueryInterface: completion_query_interface,
    AddRef: completion_add_ref,
    Release: completion_release,
    ActivateCompleted: completion_activate_completed,
};

#[cfg(target_os = "windows")]
unsafe extern "system" fn completion_query_interface(
    this: *mut std::ffi::c_void,
    riid: *const windows::core::GUID,
    ppvObject: *mut *mut std::ffi::c_void,
) -> windows::core::HRESULT {
    use windows::core::Interface;
    use windows::Win32::Media::Audio::IActivateAudioInterfaceCompletionHandler;
    if ppvObject.is_null() {
        return windows::core::HRESULT(0x80004003u32 as i32); // E_POINTER
    }
    unsafe {
        let iid = *riid;
        if iid == windows::core::IUnknown::IID || iid == IActivateAudioInterfaceCompletionHandler::IID {
            *ppvObject = this;
            completion_add_ref(this);
            return windows::core::HRESULT(0); // S_OK
        }
        *ppvObject = std::ptr::null_mut();
        windows::core::HRESULT(0x80004002u32 as i32) // E_NOINTERFACE
    }
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn completion_add_ref(this: *mut std::ffi::c_void) -> u32 {
    let obj = unsafe { &*(this as *mut CompletionHandlerObj) };
    obj.ref_count.fetch_add(1, Ordering::Relaxed) + 1
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn completion_release(this: *mut std::ffi::c_void) -> u32 {
    let obj = unsafe { &*(this as *mut CompletionHandlerObj) };
    let prev = obj.ref_count.fetch_sub(1, Ordering::Release);
    if prev == 1 {
        std::sync::atomic::fence(Ordering::Acquire);
        unsafe {
            let _ = Box::from_raw(this as *mut CompletionHandlerObj);
        }
        0
    } else {
        prev - 1
    }
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn completion_activate_completed(
    this: *mut std::ffi::c_void,
    activate_op_ptr: *mut std::ffi::c_void,
) -> windows::core::HRESULT {
    use windows::core::Interface;
    use windows::Win32::Media::Audio::*;

    let obj = unsafe { &*(this as *mut CompletionHandlerObj) };
    let sender = obj.sender.lock().unwrap().take();

    if activate_op_ptr.is_null() {
        if let Some(s) = sender {
            let _ = s.send(Err("No async operation returned".into()));
        }
        return windows::core::HRESULT(0);
    }

    let op: IActivateAudioInterfaceAsyncOperation = unsafe {
        std::mem::transmute(activate_op_ptr)
    };

    let mut hr = windows::core::HRESULT(0);
    let mut unk: Option<windows::core::IUnknown> = None;

    unsafe {
        if let Ok(_) = op.GetActivateResult(&mut hr, &mut unk) {
            if hr.is_ok() {
                if let Some(u) = unk {
                    if let Ok(client) = u.cast::<IAudioClient>() {
                        if let Some(s) = sender {
                            let _ = s.send(Ok(client));
                        }
                        std::mem::forget(op);
                        return windows::core::HRESULT(0);
                    }
                }
            }
        }
    }

    if let Some(s) = sender {
        let _ = s.send(Err(format!("GetActivateResult failed with HRESULT: 0x{:08X}", hr.0)));
    }
    std::mem::forget(op);
    windows::core::HRESULT(0)
}

/// Helper: Activate WASAPI Process-Specific Loopback using ActivateAudioInterfaceAsync
#[cfg(target_os = "windows")]
fn activate_process_loopback(pid: u32) -> Result<windows::Win32::Media::Audio::IAudioClient, String> {
    use windows::core::{Interface, PCWSTR, PROPVARIANT};
    use windows::Win32::Media::Audio::*;

    #[repr(C)]
    struct ActivationParamsWrapper {
        type_: AUDIOCLIENT_ACTIVATION_TYPE,
        params: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS,
    }

    let act_params = ActivationParamsWrapper {
        type_: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
        params: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
            TargetProcessId: pid,
            ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
        },
    };

    #[repr(C)]
    struct RawPropVariant {
        vt: u16,
        w_reserved1: u16,
        w_reserved2: u16,
        w_reserved3: u16,
        cb_size: u32,
        p_blob_data: *mut u8,
        _pad: u32,
    }

    let raw_prop = RawPropVariant {
        vt: 0x0041, // VT_BLOB
        w_reserved1: 0,
        w_reserved2: 0,
        w_reserved3: 0,
        cb_size: std::mem::size_of::<ActivationParamsWrapper>() as u32,
        p_blob_data: &act_params as *const _ as *mut u8,
        _pad: 0,
    };

    let (tx, rx) = std::sync::mpsc::channel::<Result<IAudioClient, String>>();

    let handler_obj = Box::new(CompletionHandlerObj {
        vtbl: &COMPLETION_HANDLER_VTBL,
        ref_count: std::sync::atomic::AtomicU32::new(1),
        sender: Mutex::new(Some(tx)),
    });
    let handler_ptr = Box::into_raw(handler_obj) as *mut std::ffi::c_void;

    let device_path: Vec<u16> = "{13902FD4-701A-42A8-9477-0C7F7BC8645D}\0".encode_utf16().collect();
    let prop_ptr = &raw_prop as *const _ as *const PROPVARIANT;

    unsafe {
        let handler: IActivateAudioInterfaceCompletionHandler = std::mem::transmute(handler_ptr);
        let res = ActivateAudioInterfaceAsync(
            PCWSTR(device_path.as_ptr()),
            &IAudioClient::IID,
            Some(prop_ptr),
            &handler,
        );
        std::mem::forget(handler);
        res.map_err(|e| format!("ActivateAudioInterfaceAsync call failed: {:?}", e))?;
    }

    rx.recv_timeout(Duration::from_secs(3))
        .map_err(|_| "Timed out waiting for WASAPI process loopback activation".to_string())?
}

/// Helper: Activate WASAPI Default Render Device Loopback
#[cfg(target_os = "windows")]
fn activate_default_loopback() -> Result<windows::Win32::Media::Audio::IAudioClient, String> {
    use windows::Win32::Media::Audio::*;
    use windows::Win32::System::Com::*;

    unsafe {
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
                .map_err(|e| format!("CoCreateInstance(MMDeviceEnumerator) failed: {:?}", e))?;

        let device = enumerator
            .GetDefaultAudioEndpoint(eRender, eConsole)
            .map_err(|e| format!("GetDefaultAudioEndpoint failed: {:?}", e))?;

        let client: IAudioClient = device
            .Activate(CLSCTX_ALL, None)
            .map_err(|e| format!("IMMDevice::Activate failed: {:?}", e))?;

        Ok(client)
    }
}
