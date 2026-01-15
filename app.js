const app = {
  peer: null,
  conn: null,
  myCode: null,
  filesToSend: [],
  receivedFileParts: [],
  receivedFileMeta: null,
  receivedBlob: null,
  role: null,
  wakeLockSentinel: null,
  isTransferring: false,
  isFileHeld: false,

  init: () => {
    const dropZone = document.getElementById("drop-zone");
    const fileInput = document.getElementById("file-input");

    if (dropZone) {
      dropZone.addEventListener("dragover", (e) => {
        e.preventDefault();
        dropZone.classList.add("border-brand-accent");
        dropZone.classList.add("bg-brand-accent/10");
      });
      dropZone.addEventListener("dragleave", (e) => {
        e.preventDefault();
        dropZone.classList.remove("border-brand-accent");
        dropZone.classList.remove("bg-brand-accent/10");
      });
      dropZone.addEventListener("drop", (e) => {
        e.preventDefault();
        dropZone.classList.remove("border-brand-accent");
        dropZone.classList.remove("bg-brand-accent/10");
        if (e.dataTransfer.files) app.handleFiles(e.dataTransfer.files);
      });
      fileInput.addEventListener("change", (e) => {
        if (fileInput.files) app.handleFiles(fileInput.files);
      });
    }

    window.addEventListener("beforeunload", (e) => {
      if (app.isFileHeld) {
        e.preventDefault();
        e.returnValue = "";
      }
    });

    console.log("SharePeer Initialized");
  },

  goHome: () => {
    if (app.isFileHeld) {
      if (
        !confirm(
          "You have unsaved files. Are you sure you want to discard them?"
        )
      )
        return;
      app.discardFile();
    }
    if (app.peer) {
      app.peer.destroy();
      app.peer = null;
    }
    app.switchView("home-view");
    app.resetState();
  },

  showSend: () => {
    app.role = "sender";
    app.switchView("send-view");
  },

  showReceive: () => {
    app.role = "receiver";
    app.switchView("receive-view");

    document.getElementById("code-1").value = "";
    document.getElementById("code-2").value = "";
    document.getElementById("code-3").value = "";
  },

  switchView: (viewId) => {
    document.querySelectorAll(".view-section").forEach((el) => {
      el.classList.remove("active");
      el.style.display = "none";
    });
    const target = document.getElementById(viewId);
    target.style.display = "flex";

    void target.offsetWidth;
    target.classList.add("active");
  },

  closeSession: () => {
    if (app.conn) {
      app.conn.removeAllListeners("close");
      app.conn.close();
    }
    if (app.peer) {
      app.peer.destroy();
      app.peer = null;
    }
    app.conn = null;

    document.getElementById("code-display-area").classList.add("hidden");
    document.getElementById("code-display-area").classList.remove("flex");
    document.getElementById("btn-ready").classList.remove("hidden");

    const statusEl = document.getElementById("connection-status");
    if (statusEl) {
      statusEl.innerHTML = `
                <div class="w-2 h-2 rounded-full bg-amber-400 animate-pulse"></div>
                Waiting for peer connection...
            `;
      statusEl.classList.add(
        "text-amber-400",
        "bg-amber-400/10",
        "border-amber-400/20"
      );
      statusEl.classList.remove(
        "text-green-400",
        "bg-green-400/10",
        "border-green-400/20"
      );
    }

    app.showToast("Transfer finished. Session closed.", "success");
  },

  resetState: () => {
    app.filesToSend = [];
    app.receivedFileParts = [];
    app.receivedFileMeta = null;
    app.receivedBlob = null;
    app.receivedFilesList = [];
    app.isTransferring = false;
    app.isFileHeld = false;

    const dropContent = document.getElementById("drop-content-empty");
    const fileList = document.getElementById("file-list");
    const btnReady = document.getElementById("btn-ready");
    const codeDisplay = document.getElementById("code-display-area");

    if (dropContent) dropContent.style.display = "block";
    if (fileList) {
      fileList.innerHTML = "";
      fileList.classList.add("hidden");
    }
    if (btnReady) btnReady.classList.add("hidden");
    if (codeDisplay) codeDisplay.classList.add("hidden");

    const inputs = document.querySelectorAll(".code-input");
    inputs.forEach((i) => (i.value = ""));
  },

  handleFiles: (fileList) => {
    const newFiles = Array.from(fileList);
    let duplicateRenamedCount = 0;

    newFiles.forEach((f) => {
      let finalName = f.name;
      let counter = 1;
      let originalNameBase = finalName;
      let extension = "";

      const dotIndex = finalName.lastIndexOf(".");
      if (dotIndex !== -1) {
        originalNameBase = finalName.substring(0, dotIndex);
        extension = finalName.substring(dotIndex);
      }

      while (app.filesToSend.some((existing) => existing.name === finalName)) {
        if (finalName === f.name) duplicateRenamedCount++;

        finalName = `${originalNameBase} (${counter})${extension}`;
        counter++;
      }

      if (finalName !== f.name) {
        try {
          const renamedFile = new File([f], finalName, {
            type: f.type,
            lastModified: f.lastModified,
          });
          app.filesToSend.push(renamedFile);
        } catch (e) {
          console.error("Renaming failed", e);
          app.filesToSend.push(f);
        }
      } else {
        app.filesToSend.push(f);
      }
    });

    if (duplicateRenamedCount > 0) {
      app.showToast(
        `${duplicateRenamedCount} duplicate(s) renamed automatically.`,
        "info"
      );
    }

    app.renderFileList();
  },

  renderFileList: () => {
    const listEl = document.getElementById("file-list");
    const btnReady = document.getElementById("btn-ready");

    listEl.innerHTML = "";

    if (app.filesToSend.length > 0) {
      listEl.classList.remove("hidden");
      btnReady.classList.remove("hidden");

      app.filesToSend.forEach((f, index) => {
        const row = document.createElement("div");
        row.className =
          "flex items-center justify-between p-3 bg-slate-800 rounded-lg border border-slate-700 animate-fade-in-up";
        row.style.animationDelay = `${index * 50}ms`;
        row.innerHTML = `
                    <div class="flex items-center gap-3 overflow-hidden">
                        <div class="bg-blue-500/20 p-2 rounded text-blue-400">
                           <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path></svg>
                        </div>
                        <div class="truncate text-sm text-slate-200">${
                          f.name
                        }</div>
                    </div>
                    <div class="flex items-center gap-3">
                        <div class="text-xs text-slate-500 whitespace-nowrap">${app.formatSize(
                          f.size
                        )}</div>
                        <button onclick="app.removeFile(${index})" class="text-slate-500 hover:text-red-400 transition">
                            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                        </button>
                    </div>
                `;
        listEl.appendChild(row);
      });
    } else {
      listEl.classList.add("hidden");
      btnReady.classList.add("hidden");
    }
  },

  removeFile: (index) => {
    app.filesToSend.splice(index, 1);
    app.renderFileList();
  },

  generateCode: () => {
    const charsAlpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const charsNum = "0123456789";

    const rAlpha = (len) =>
      Array(len)
        .fill(0)
        .map(() => charsAlpha[Math.floor(Math.random() * charsAlpha.length)])
        .join("");
    const rNum = (len) =>
      Array(len)
        .fill(0)
        .map(() => charsNum[Math.floor(Math.random() * charsNum.length)])
        .join("");
    const rMix = (len) =>
      Array(len)
        .fill(0)
        .map(
          () =>
            (charsAlpha + charsNum)[
              Math.floor(Math.random() * (charsAlpha + charsNum).length)
            ]
        )
        .join("");

    const p1 = rMix(3);
    const p2 = rNum(3);
    const p3 = rMix(3);

    app.myCode = `${p1}-${p2}-${p3}`;
    const rawId = app.myCode.replace(/-/g, "");

    document.getElementById("generated-code").innerText = app.myCode;
    document.getElementById("btn-ready").classList.add("hidden");

    const codeDisplay = document.getElementById("code-display-area");
    codeDisplay.classList.remove("hidden");
    codeDisplay.classList.add("flex");

    const statusEl = document.getElementById("connection-status");
    if (statusEl) {
      statusEl.innerHTML = `
                <div class="w-2 h-2 rounded-full bg-amber-400 animate-pulse"></div>
                Waiting for peer connection...
            `;
      statusEl.classList.add(
        "text-amber-400",
        "bg-amber-400/10",
        "border-amber-400/20"
      );
      statusEl.classList.remove(
        "text-green-400",
        "bg-green-400/10",
        "border-green-400/20"
      );
    }

    app.initSenderPeer(rawId);
  },

  initSenderPeer: (id) => {
    app.showToast("Initializing Network...", "info");

    const fullId = `spf-${id}`;

    app.peer = new Peer(fullId, {
      debug: 1,
      config: {
        iceServers: [
          { url: "stun:stun.l.google.com:19302" },
          { url: "stun:stun1.l.google.com:19302" },
        ],
      },
    });

    app.peer.on("open", (id) => {
      console.log("My peer ID is: " + id);
      app.showToast("Ready for connection!", "success");
    });

    app.peer.on("connection", (conn) => {
      if (app.conn && app.conn.open) {
        console.warn("Rejected extra connection attempt");
        conn.close();
        return;
      }

      console.log("Incoming connection...");
      app.conn = conn;
      app.setupConnectionHandlers(conn);
    });

    app.peer.on("disconnected", () => {
      console.log("Connection to signaling server lost. Reconnecting...");

      app.peer.reconnect();
    });

    app.peer.on("error", (err) => {
      console.error(err);
      app.handlePeerError(err);
    });
  },

  handlePeerError: (err) => {
    if (err.type === "browser-incompatible") {
      app.showToast(
        "Browser incompatible. Please use Chrome/Firefox.",
        "error"
      );
    } else if (err.type === "disconnected") {
      app.showToast("Disconnected from network.", "error");
    } else if (err.type === "network") {
      app.showToast("Network error. Checking connection...", "error");
    } else if (err.type === "peer-unavailable") {
      app.showToast("Peer not found. Check the code.", "error");

      const btn = document.getElementById("btn-connect");
      if (btn) {
        btn.disabled = false;
        btn.innerText = "Connect & Receive";
      }
    } else {
      if (
        err.type === "server-error" ||
        err.message.includes("Lost connection")
      ) {
        console.log("Retrying connection...");
        if (app.peer && !app.peer.destroyed) {
          setTimeout(() => app.peer.reconnect(), 1000);
        }
      } else {
        app.showToast("Error: " + (err.message || "Unknown error"), "error");
      }
    }
  },

  setupConnectionHandlers: (conn) => {
    conn.on("open", () => {
      console.log("Connected to: " + conn.peer);
      app.conn = conn;

      if (app.role === "sender") {
        const statusEl = document.getElementById("connection-status");
        if (statusEl) {
          statusEl.innerHTML = `
                        <div class="w-2 h-2 rounded-full bg-green-400 shadow-[0_0_10px_rgba(74,222,128,0.5)]"></div>
                        Device Connected
                    `;
          statusEl.classList.remove(
            "text-amber-400",
            "bg-amber-400/10",
            "border-amber-400/20"
          );
          statusEl.classList.add(
            "text-green-400",
            "bg-green-400/10",
            "border-green-400/20"
          );
        }

        app.showToast("Receiver Connected!", "success");
        setTimeout(() => app.startFileTransfer(), 500);
      } else {
        app.showToast("Connected to Sender!", "success");
      }
    });

    conn.on("data", (data) => {
      app.handleIncomingData(data);
    });

    conn.on("close", () => {
      app.showToast("Peer Disconnected", "info");

      if (app.role === "sender") {
        const statusEl = document.getElementById("connection-status");
        if (statusEl) {
          statusEl.innerHTML = `
                         <div class="w-2 h-2 rounded-full bg-amber-400 animate-pulse"></div>
                         Waiting for peer connection...
                     `;
          statusEl.classList.add(
            "text-amber-400",
            "bg-amber-400/10",
            "border-amber-400/20"
          );
          statusEl.classList.remove(
            "text-green-400",
            "bg-green-400/10",
            "border-green-400/20"
          );
        }
      }

      app.toggleTransferPopup(false);
      if (!app.isFileHeld) app.resetState();
    });

    conn.on("error", (err) => {
      console.error("Conn Error", err);
      app.showToast("Transfer Connection Error", "error");
    });
  },

  handleInputMove: (input, nextId) => {
    if (input.value.length >= 3 && nextId) {
      document.getElementById(nextId).focus();
    }
  },

  handleBackspace: (e, input, prevId) => {
    if (e.key === "Backspace" && input.value.length === 0 && prevId) {
      document.getElementById(prevId).focus();
    }
  },

  handlePaste: (e) => {
    e.preventDefault();
    const paste = (e.clipboardData || window.clipboardData).getData("text");

    const clean = paste.replace(/[^a-zA-Z0-9]/g, "");

    if (clean.length === 9) {
      document.getElementById("code-1").value = clean.substring(0, 3);
      document.getElementById("code-2").value = clean.substring(3, 6);
      document.getElementById("code-3").value = clean.substring(6, 9);

      document.getElementById("btn-connect").focus();
    } else {
      const active = document.activeElement;
      if (active && active.classList.contains("code-input")) {
        const remaining = clean.substring(0, 3);
        active.value = remaining;

        app.handleInputMove(
          active,
          active.id === "code-1"
            ? "code-2"
            : active.id === "code-2"
            ? "code-3"
            : null
        );
      }
    }
  },

  connectToPeer: (retryCount = 0) => {
    const c1 = document.getElementById("code-1").value;
    const c2 = document.getElementById("code-2").value;
    const c3 = document.getElementById("code-3").value;

    if (c1.length < 3 || c2.length < 3 || c3.length < 3) {
      app.showToast("Please enter the full 9-character code.", "error");
      return;
    }

    const fullCode = `${c1}${c2}${c3}`;
    const peerId = `spf-${fullCode}`;

    document.getElementById("btn-connect").disabled = true;
    document.getElementById("btn-connect").innerText =
      retryCount > 0 ? `Retry (${retryCount})...` : "Connecting...";

    if (!app.peer || app.peer.destroyed) {
      app.peer = new Peer({
        debug: 1,
        config: { iceServers: [{ url: "stun:stun.l.google.com:19302" }] },
      });
    }

    const attemptConnect = () => {
      if (!app.peer || app.peer.destroyed) return;

      const conn = app.peer.connect(peerId, { reliable: true });

      let connected = false;

      conn.on("open", () => {
        connected = true;
        app.conn = conn;
        document.getElementById("btn-connect").innerText = "Connected!";
        app.setupConnectionHandlers(conn);
      });

      conn.on("error", (err) => {
        if (!connected) handleFailure();
      });
      conn.on("close", () => {
        if (!connected) handleFailure();
      });

      setTimeout(() => {
        if (!connected && !conn.open) {
          conn.close();
          handleFailure();
        }
      }, 4000);

      function handleFailure() {
        if (retryCount < 2) {
          console.log(
            `Connection attempt ${retryCount + 1} failed. Retrying...`
          );
          setTimeout(() => app.connectToPeer(retryCount + 1), 1000);
        } else {
          app.showToast("Connection failed. Is the sender ready?", "error");
          document.getElementById("btn-connect").disabled = false;
          document.getElementById("btn-connect").innerText =
            "Connect & Receive";
        }
      }
    };

    if (app.peer.open) {
      attemptConnect();
    } else {
      app.peer.on("open", attemptConnect);

      app.peer.on("error", (err) => {
        app.showToast("Peer Init Error: " + err.type, "error");
        document.getElementById("btn-connect").disabled = false;
      });
    }
  },

  startFileTransfer: async () => {
    if (!app.filesToSend.length) return;

    app.toggleTransferPopup(true);

    const wakeCheckbox = document.getElementById("wakelock-checkbox");
    if (wakeCheckbox) {
      wakeCheckbox.checked = true;
      app.requestWakeLock();
    }

    app.sendQueueIndex = 0;
    app.processNextFileToSend();
  },

  processNextFileToSend: async () => {
    if (app.sendQueueIndex >= app.filesToSend.length) {
      app.conn.send({ type: "batch-complete" });
      app.showToast("All files sent successfully!", "success");

      const statusEl = document.getElementById("connection-status");
      if (statusEl) {
        statusEl.innerHTML = `
                    <div class="w-2 h-2 rounded-full bg-blue-400 shadow-[0_0_10px_rgba(96,165,250,0.5)]"></div>
                    Files Sent
                `;
        statusEl.classList.remove(
          "text-green-400",
          "bg-green-400/10",
          "border-green-400/20"
        );
        statusEl.classList.add(
          "text-blue-400",
          "bg-blue-400/10",
          "border-blue-400/20"
        );
      }

      app.toggleTransferPopup(false);

      setTimeout(() => {
        app.closeSession();
      }, 3000);
      return;
    }

    const file = app.filesToSend[app.sendQueueIndex];

    app.conn.send({
      type: "file-start",
      name: file.name,
      size: file.size,
      mime: file.type,
      index: app.sendQueueIndex,
      totalFiles: app.filesToSend.length,
    });

    await app.sendFileChunks(file);
  },

  sendFileChunks: async (file) => {
    const chunkSize = 64 * 1024;
    let offset = 0;

    let lastUpdate = 0;
    const updateInterval = 100;

    while (offset < file.size) {
      if (!app.conn || !app.conn.open) {
        console.error("Connection lost during transfer");
        return;
      }

      const chunk = file.slice(offset, offset + chunkSize);
      const buffer = await chunk.arrayBuffer();

      const dataChannel = app.conn.dataChannel;
      if (dataChannel && dataChannel.bufferedAmount > 16 * 1024 * 1024) {
      }

      if (dataChannel && dataChannel.bufferedAmount > 1024 * 1024) {
        await new Promise((resolve) => {
          const handler = () => {
            dataChannel.removeEventListener("bufferedamountlow", handler);
            resolve();
          };

          const poller = setInterval(() => {
            if (dataChannel.bufferedAmount < 512 * 1024) {
              clearInterval(poller);
              if (dataChannel.removeEventListener)
                dataChannel.removeEventListener("bufferedamountlow", handler);
              resolve();
            }
          }, 50);
        });
      }

      app.conn.send(buffer);

      offset += chunkSize;

      const now = Date.now();
      if (now - lastUpdate > updateInterval || offset >= file.size) {
        const percent = Math.min(100, Math.round((offset / file.size) * 100));
        app.updateProgress(
          percent,
          `Sending ${app.sendQueueIndex + 1}/${app.filesToSend.length}: ${
            file.name
          }`
        );
        lastUpdate = now;
      }
    }

    app.conn.send({ type: "file-end" });

    app.sendQueueIndex++;

    setTimeout(() => app.processNextFileToSend(), 50);
  },

  handleIncomingData: (data) => {
    if (data instanceof ArrayBuffer || data instanceof Uint8Array) {
      if (!app.receivedFileMeta) return;

      app.receivedFileParts.push(data);
      app.receivedBytes += data.byteLength;

      const now = Date.now();
      if (!app.lastReceiverUpdate) app.lastReceiverUpdate = 0;

      if (
        now - app.lastReceiverUpdate > 100 ||
        app.receivedBytes >= app.receivedFileMeta.size
      ) {
        const percent = Math.min(
          100,
          Math.round((app.receivedBytes / app.receivedFileMeta.size) * 100)
        );
        app.updateProgress(percent, `Receiving ${app.receivedFileMeta.name}`);
        app.lastReceiverUpdate = now;
      }
      return;
    }

    if (data.type === "file-start") {
      app.receivedFileMeta = data;
      app.receivedFileParts = [];
      app.receivedBytes = 0;
      app.lastReceiverUpdate = 0;

      app.toggleTransferPopup(true);
      app.updateProgress(
        0,
        `Receiving ${data.index + 1}/${data.totalFiles}: ${data.name}`
      );

      if (!app.receivedFilesList) app.receivedFilesList = [];
    } else if (data.type === "file-end") {
      app.updateProgress(100, "Processing...");
      const blob = new Blob(app.receivedFileParts, {
        type: app.receivedFileMeta.mime,
      });

      const fileRecord = {
        meta: app.receivedFileMeta,
        blob: blob,
      };
      app.receivedFilesList.push(fileRecord);
      app.isFileHeld = true;

      app.addFileToReceivedModal(fileRecord, app.receivedFilesList.length - 1);
    } else if (data.type === "batch-complete") {
      app.toggleTransferPopup(false);
      app.showToast("All files received!", "success");
      app.showReceivedModal();
    }
  },

  addFileToReceivedModal: (fileRecord, index) => {
    const listContainer = document.getElementById("received-files-list");
    const ext = fileRecord.meta.name.split(".").pop().substring(0, 4);

    const el = document.createElement("div");
    el.className =
      "bg-slate-800/50 rounded-lg p-3 border border-slate-700 flex items-center justify-between gap-3 mb-2";
    el.innerHTML = `
            <div class="flex items-center gap-3 overflow-hidden">
                <div class="bg-slate-700 p-2 rounded text-slate-300 font-bold uppercase text-xs h-10 w-10 flex items-center justify-center flex-shrink-0">
                    ${ext}
                </div>
                <div class="overflow-hidden text-left">
                    <h4 class="text-white text-sm font-medium truncate max-w-[150px]">${
                      fileRecord.meta.name
                    }</h4>
                    <p class="text-slate-500 text-[10px]">${app.formatSize(
                      fileRecord.meta.size
                    )}</p>
                </div>
            </div>
            <button onclick="app.downloadFile(${index})" class="bg-blue-600 text-white hover:bg-blue-500 px-4 py-2 rounded-lg transition shadow-sm text-xs font-medium flex-shrink-0">
                Download
            </button>
        `;
    listContainer.appendChild(el);
  },

  showReceivedModal: () => {
    const modal = document.getElementById("file-received-modal");
    modal.classList.remove("hidden");
    modal.classList.add("flex");
  },

  toggleTransferPopup: (show) => {
    const p = document.getElementById("transfer-popup");
    const c = document.getElementById("transfer-content");
    if (show) {
      p.classList.remove("hidden");
      setTimeout(() => {
        p.classList.remove("opacity-0");
        c.classList.remove("scale-95");
        c.classList.add("scale-100");
      }, 10);
      app.isTransferring = true;
    } else {
      p.classList.add("opacity-0");
      c.classList.remove("scale-100");
      c.classList.add("scale-95");
      setTimeout(() => {
        p.classList.add("hidden");
      }, 300);
      app.isTransferring = false;
    }
  },

  updateProgress: (val, text) => {
    document.getElementById("transfer-progress-bar").style.width = val + "%";
    if (text) document.getElementById("transfer-status-text").innerText = text;
  },

  formatSize: (bytes) => {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const result = bytes / k;
    if (result < 1) return bytes + " B";
    const sizes = ["KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return (
      parseFloat((bytes / Math.pow(k, i)).toFixed(2)) +
      " " +
      (sizes[i - 1] || "KB")
    );
  },

  downloadFile: (index) => {
    const file = app.receivedFilesList[index];
    if (!file) return;

    const url = URL.createObjectURL(file.blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = file.meta.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    if (app.receivedFilesList.length === 1) {
      app.discardFile();
    } else {
      app.showToast("Download started", "success");
    }
  },

  discardFile: () => {
    app.isFileHeld = false;
    app.receivedFilesList = [];
    app.receivedFileParts = [];
    app.receivedFileMeta = null;

    document.getElementById("received-files-list").innerHTML = "";

    document.getElementById("file-received-modal").classList.add("hidden");
    document.getElementById("file-received-modal").classList.remove("flex");

    app.goHome();
  },

  checkWakeLock: () => {
    const checkbox = document.getElementById("wakelock-checkbox");
    if (checkbox && checkbox.checked) {
      app.requestWakeLock();
    }
  },

  toggleWakeLock: (el) => {
    if (el.checked) {
      if (app.isTransferring) app.requestWakeLock();
    } else {
      app.releaseWakeLock();
    }
  },

  requestWakeLock: async () => {
    try {
      if ("wakeLock" in navigator) {
        app.wakeLockSentinel = await navigator.wakeLock.request("screen");
        console.log("Screen Wake Lock active");
        app.wakeLockSentinel.addEventListener("release", () => {
          console.log("Screen Wake Lock released");
        });
      }
    } catch (err) {
      console.error(`${err.name}, ${err.message}`);
    }
  },

  releaseWakeLock: async () => {
    if (app.wakeLockSentinel) {
      await app.wakeLockSentinel.release();
      app.wakeLockSentinel = null;
    }
  },

  showToast: (message, type = "info") => {
    const container = document.getElementById("toast-container");
    const el = document.createElement("div");

    let bg = "bg-slate-800";
    let border = "border-slate-600";
    let icon = "";

    if (type === "success") {
      bg = "bg-slate-900";
      border = "border-brand-accent";
      icon = '<span class="text-green-400">✓</span>';
    }
    if (type === "error") {
      bg = "bg-red-900/90";
      border = "border-red-500";
      icon = '<span class="text-white">✕</span>';
    }

    el.className = `toast p-4 rounded-xl border ${border} ${bg} text-white shadow-lg flex items-center gap-3 min-w-[300px] pointer-events-auto`;
    el.innerHTML = `
            ${icon}
            <div class="text-sm font-medium">${message}</div>
        `;

    container.appendChild(el);

    requestAnimationFrame(() => {
      el.classList.add("show");
    });

    setTimeout(() => {
      el.classList.remove("show");
      setTimeout(() => el.remove(), 300);
    }, 4000);
  },
};

document.addEventListener("DOMContentLoaded", app.init);
