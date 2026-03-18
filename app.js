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
  ecdhKeyPair: null,
  sharedSecret: null,
  identityKeyPair: null,
  trustedPeers: [],
  stealthListeners: [],
  activeConnections: 0,

  init: async () => {
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
      if (app.isTransferring || app.receivedFileParts.length > 0) {
        if (app.dbReady && app.db) {
          const transaction = app.db.transaction("files", "readwrite");
          transaction.objectStore("files").clear();
        }
      }

      if (app.isFileHeld || app.isTransferring) {
        e.preventDefault();
        e.returnValue = "";
      }
    });

    window.addEventListener("paste", app.handleGlobalPaste);

    console.log("SharePeer Initialized");

    const urlParams = new URLSearchParams(window.location.search);
    const hashMatch = window.location.hash.match(/#([a-zA-Z0-9]{9})/);
    const codeParam = (hashMatch ? hashMatch[1] : null) || urlParams.get("code");
    if (codeParam && codeParam.length === 9) {
      app.showReceive();
      document.getElementById("code-1").value = codeParam.substring(0, 3).toUpperCase();
      document.getElementById("code-2").value = codeParam.substring(3, 6).toUpperCase();
      document.getElementById("code-3").value = codeParam.substring(6, 9).toUpperCase();

      app.cleanUrl();
      setTimeout(() => app.requestConnection(), 500);
    }

    try {
      app.ecdhKeyPair = await crypto.subtle.generateKey(
        { name: "ECDH", namedCurve: "P-256" },
        true,
        ["deriveKey", "deriveBits"]
      );
    } catch (e) {
      console.error("ECDH Init Error", e);
    }
  },

  cleanUrl: () => {
    const url = new URL(window.location);
    url.searchParams.delete("code");
    url.hash = "";
    window.history.replaceState({}, document.title, url.pathname);
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
    if (app.isFileHeld) return;

    app.filesToSend = [];
    app.receivedFileParts = [];
    app.receivedFileMeta = null;
    app.receivedBlob = null;
    app.receivedFilesList = [];
    app.isTransferring = false;
    app.isFileHeld = false;
    app.isStealthConnection = false;
    app.connectedPeerPubKey = null;
    app.connectedPeerName = null;

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

    const secCodeDisplay = document.getElementById("security-code-display");
    if (secCodeDisplay) secCodeDisplay.classList.add("hidden");

    const inputs = document.querySelectorAll(".code-input");
    inputs.forEach((i) => (i.value = ""));

    if (app.role === "receiver") {
        app.startStealthListeners(true);
    }
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
        const safeName = window.DOMPurify ? window.DOMPurify.sanitize(f.name) : f.name.replace(/</g, "&lt;").replace(/>/g, "&gt;");
        const row = document.createElement("div");
        row.className =
          "flex items-center justify-between p-3 bg-slate-800 rounded-lg border border-slate-700 animate-fade-in-up";
        row.style.animationDelay = `${index * 50}ms`;
        row.innerHTML = `
                    <div class="flex items-center gap-3 overflow-hidden">
                        <div class="bg-blue-500/20 p-2 rounded text-blue-400">
                           <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path></svg>
                        </div>
                        <div class="truncate text-sm text-slate-200">${safeName}</div>
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
      statusEl.classList.remove(
        "text-green-400", "bg-green-400/10", "border-green-400/20",
        "text-blue-400", "bg-blue-400/10", "border-blue-400/20",
        "text-amber-400", "bg-amber-400/10", "border-amber-400/20"
      );

      statusEl.classList.add(
        "text-amber-400",
        "bg-amber-400/10",
        "border-amber-400/20"
      );
    }

    app.initSenderPeer(rawId);
    app.renderQRCode(rawId);
  },

  generateSecuredId: async (rawId, stepOffset = 0) => {
    const timeStep = Math.floor(Date.now() / 60000) + stepOffset;
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      "raw", enc.encode(rawId), { name: "PBKDF2" }, false, ["deriveBits", "deriveKey"]
    );
    const bits = await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        salt: enc.encode(timeStep.toString()),
        iterations: 100000,
        hash: "SHA-256"
      },
      keyMaterial,
      128
    );
    const hashArray = Array.from(new Uint8Array(bits));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

    return `spf-${hashHex}`;
  },

  renderQRCode: (code) => {
    const qrEl = document.getElementById("qrcode");
    if (!qrEl) return;
    qrEl.innerHTML = "";
    const shareUrl = `${window.location.origin}${window.location.pathname}#${code}`;
    new QRCode(qrEl, {
      text: shareUrl,
      width: 160,
      height: 160,
      colorDark: "#0f172a",
      colorLight: "#ffffff",
      correctLevel: QRCode.CorrectLevel.H,
    });
  },

  initSenderPeer: async (id) => {
    app.showToast("Initializing Network...", "info");

    const fullId = await app.generateSecuredId(id, 0);

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
      app.showAuthModal("Securing Connection...");
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

      if (app.isStealthConnection) {
        if (app.role === "sender") {
          app.ecdsaChallenge = Math.random().toString(36).substring(2, 10);
          app.showAuthModal("Securing Stealth Link...");
          conn.send({ type: 'ecdsa_challenge', challenge: app.ecdsaChallenge });
        }
      } else {
        if (app.role === "sender") {
          const challenge = Math.random().toString(36).substring(2, 10);
          app.powChallenge = challenge;
          conn.send({ type: 'pow_challenge', challenge: challenge });
        }
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

      if (app.role === "sender") {
        app.toggleTransferPopup(false);
        if (!app.isFileHeld) app.resetState();
      } else {
        if (!app.isFileHeld) {
          app.toggleTransferPopup(false);
          app.resetState();
        }
      }
    });

    conn.on("error", (err) => {
      console.error("Conn Error", err);
      app.showToast("Transfer Connection Error", "error");
    });
  },

  handleInputMove: (input, nextId) => {
    if (input.value.length >= 3 && nextId) {
      document.getElementById(nextId).focus();
    } else if (input.id === 'code-3' && input.value.length === 3) {
      app.requestConnection();
    }
  },

  handleInputKeydown: (e, input, prevId) => {
    if (e.key === "Backspace" && input.value.length === 0 && prevId) {
      document.getElementById(prevId).focus();
    } else if (e.key === "Enter") {
      app.requestConnection();
    }
  },

  handleGlobalPaste: (e) => {
    if (app.role !== "sender" || app.conn || app.myCode) return;
    const items = (e.clipboardData || e.originalEvent.clipboardData).items;
    let files = [];
    let textPromises = [];
    for (const item of items) {
      if (item.kind === "file") {
        const f = item.getAsFile();
        if (f) files.push(f);
      } else if (item.kind === "string" && item.type === "text/plain") {
        textPromises.push(new Promise(resolve => {
          item.getAsString((text) => {
            const clean = window.DOMPurify ? window.DOMPurify.sanitize(text) : text;
            const f = new File([clean], `Pasted_Text_${Date.now()}.clipboard`, { type: "text/plain" });
            resolve(f);
          });
        }));
      }
    }
    Promise.all(textPromises).then(textFiles => {
      const allFiles = [...files, ...textFiles];
      if (allFiles.length > 0) {
        if (confirm(`Do you want to add ${allFiles.length} item(s) from clipboard to the transfer list?`)) {
          app.handleFiles(allFiles);
        }
      }
    });
  },

  triggerPasteFromButton: async (e) => {
    e.preventDefault();
    if (app.role !== "sender" || app.conn || app.myCode) return;
    try {
      const clipboardItems = await navigator.clipboard.read();
      let files = [];
      for (const clipboardItem of clipboardItems) {
        for (const type of clipboardItem.types) {
          const blob = await clipboardItem.getType(type);
          if (type.startsWith("image/")) {
            const ext = type.split('/')[1] || 'png';
            const f = new File([blob], `Pasted_Image_${Date.now()}.${ext}`, { type });
            files.push(f);
          } else if (type === "text/plain") {
            const text = await blob.text();
            const clean = window.DOMPurify ? window.DOMPurify.sanitize(text) : text;
            const f = new File([clean], `Pasted_Text_${Date.now()}.clipboard`, { type });
            files.push(f);
          }
        }
      }
      if (files.length > 0) {
        if (confirm(`Do you want to add ${files.length} item(s) from clipboard to the transfer list?`)) {
          app.handleFiles(files);
        }
      } else {
        app.showToast("No compatible text or image found in clipboard.", "warning");
      }
    } catch (err) {
      console.warn("Clipboard API failed:", err);
      app.showToast("Clipboard access denied. Please use CTRL+V on your keyboard.", "warning");
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

  requestConnection: () => {
    const c1 = document.getElementById("code-1").value;
    const c2 = document.getElementById("code-2").value;
    const c3 = document.getElementById("code-3").value;

    if (c1.length < 3 || c2.length < 3 || c3.length < 3) {
      app.showToast("Please enter the full 9-character code.", "error");
      return;
    }

    const modal = document.getElementById("security-warning-modal");
    modal.classList.remove("hidden");
    setTimeout(() => {
      modal.classList.remove("opacity-0");
      const div = modal.querySelector("div");
      if (div) {
        div.classList.remove("scale-95");
        div.classList.add("scale-100");
      }
    }, 10);

    const cbTrust = document.getElementById("sec-cb-trust");
    const btnConfirm = document.getElementById("btn-sec-confirm");
    cbTrust.checked = false;
    btnConfirm.disabled = true;
    btnConfirm.classList.add("opacity-50", "cursor-not-allowed");

    cbTrust.onchange = (e) => {
      if (e.target.checked) {
        btnConfirm.disabled = false;
        btnConfirm.classList.remove("opacity-50", "cursor-not-allowed");
      } else {
        btnConfirm.disabled = true;
        btnConfirm.classList.add("opacity-50", "cursor-not-allowed");
      }
    };
  },

  cancelConnection: () => {
    const modal = document.getElementById("security-warning-modal");
    modal.classList.add("opacity-0");
    const div = modal.querySelector("div");
    if (div) {
      div.classList.remove("scale-100");
      div.classList.add("scale-95");
    }
    setTimeout(() => {
      modal.classList.add("hidden");
    }, 300);
  },

  confirmConnection: () => {
    app.cancelConnection();
    app.connectToPeer();
  },

  connectToPeer: async (retryCount = 0) => {
    const c1 = document.getElementById("code-1").value;
    const c2 = document.getElementById("code-2").value;
    const c3 = document.getElementById("code-3").value;

    if (c1.length < 3 || c2.length < 3 || c3.length < 3) {
      app.showToast("Please enter the full 9-character code.", "error");
      return;
    }

    const fullCode = `${c1}${c2}${c3}`;
    const fullUpperCode = fullCode.toUpperCase();

    document.getElementById("btn-connect").disabled = true;
    document.getElementById("btn-connect").innerText =
      retryCount > 0 ? `Retry (${retryCount})...` : "Connecting...";

    if (!app.peer || app.peer.destroyed) {
      app.peer = new Peer({
        debug: 1,
        config: { iceServers: [{ url: "stun:stun.l.google.com:19302" }, { url: "stun:stun1.l.google.com:19302" }] },
      });
    }

    const attemptConnect = async (offset = 0) => {
      if (!app.peer || app.peer.destroyed) return;

      const peerId = await app.generateSecuredId(fullUpperCode, offset);
      const conn = app.peer.connect(peerId, { reliable: true });

      let connected = false;

      conn.on("open", () => {
        connected = true;
        app.conn = conn;
        document.getElementById("btn-connect").innerText = "Authenticating...";
        app.showAuthModal("Securing Connection...");
        app.setupConnectionHandlers(conn);
      });

      conn.on("error", (err) => {
        if (!connected) handleFailure(offset);
      });
      conn.on("close", () => {
        if (!connected) handleFailure(offset);
      });

      setTimeout(() => {
        if (!connected && !conn.open) {
          conn.close();
          handleFailure(offset);
        }
      }, 6000);

      function handleFailure(failedOffset) {
        if (failedOffset === 0) {
          attemptConnect(-1);
        } else if (failedOffset === -1) {
          attemptConnect(1);
        } else if (retryCount < 2) {
          console.log(`Connection attempt ${retryCount + 1} failed. Retrying...`);
          setTimeout(() => app.connectToPeer(retryCount + 1), 1500);
        } else {
          app.showToast("Connection failed. Check code and connection.", "error");
          document.getElementById("btn-connect").disabled = false;
          document.getElementById("btn-connect").innerText = "Connect & Receive";
        }
      }
    };

    if (app.peer.open) {
      attemptConnect(0);
    } else {
      app.peer.on("open", () => attemptConnect(0));

      app.peer.on("error", (err) => {
        if (err.type === 'peer-unavailable') {
          return;
        }
        app.showToast("Peer Init Error: " + err.type, "error");
        document.getElementById("btn-connect").disabled = false;
        document.getElementById("btn-connect").innerText = "Connect & Receive";
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

      if (!app.isStealthConnection) {
        if (!document.getElementById("trust-prompt-container")) {
          const tc = document.createElement("div");
          tc.id = "trust-prompt-container";
          tc.className = "mt-4 flex flex-col items-center";
          tc.innerHTML = `<button onclick="app.sendTrustRequest()" class="bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-xl text-sm font-bold w-full transition">Add Device to Trusted</button>`;
          document.getElementById("transfer-content").appendChild(tc);
        }

        const pBar = document.getElementById("transfer-progress-bar");
        if (pBar) pBar.parentElement.style.display = 'none';
        const stxt = document.getElementById("transfer-status-text");
        if (stxt) stxt.style.display = 'none';

        const tit = document.querySelector("#transfer-content h3");
        if (tit) tit.innerText = "Files Sent Successfully!";

        const closeBtn = document.createElement("button");
        closeBtn.innerText = "Close Session";
        closeBtn.className = "mt-2 bg-slate-800 hover:bg-slate-700 text-slate-300 px-4 py-2 rounded-xl text-sm transition w-full";
        closeBtn.onclick = () => { app.toggleTransferPopup(false); app.closeSession(); document.getElementById("trust-prompt-container").remove(); closeBtn.remove(); };
        document.getElementById("transfer-content").appendChild(closeBtn);

      } else {
        app.toggleTransferPopup(false);
        setTimeout(() => {
          app.closeSession();
        }, 3000);
      }
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

      if (!app.sharedSecret) {
        app.showToast("E2EE Secret not established properly!", "error");
        return;
      }

      const iv = crypto.getRandomValues(new Uint8Array(12));
      const encrypted = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv }, app.sharedSecret, buffer
      );
      const payload = new Uint8Array(12 + encrypted.byteLength);
      payload.set(iv, 0);
      payload.set(new Uint8Array(encrypted), 12);

      const dataChannel = app.conn.dataChannel;
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

      app.conn.send(payload);

      offset += chunkSize;

      const now = Date.now();
      if (now - lastUpdate > updateInterval || offset >= file.size) {
        const percent = Math.min(100, Math.round((offset / file.size) * 100));
        app.updateProgress(
          percent,
          `Sending ${app.sendQueueIndex + 1}/${app.filesToSend.length}: ${file.name
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
    app.receiveQueue = (app.receiveQueue || Promise.resolve()).then(async () => {
      if (data.type === 'pow_challenge') {
        return new Promise(resolve => {
          let nonce = 0;
          app.showToast("Securing connection (PoW)...", "info");

          const attempt = async () => {
            const encoder = new TextEncoder();
            for (let i = 0; i < 200; i++) {
              const hash = await crypto.subtle.digest("SHA-256", encoder.encode(data.challenge + nonce));
              const hashArray = new Uint8Array(hash);
              if (hashArray[0] === 0 && hashArray[1] === 0 && (hashArray[2] & 0xC0) === 0) {
                app.conn.send({ type: 'pow_solution', nonce: nonce });
                const btn = document.getElementById("btn-connect");
                if (btn) btn.innerText = "Secured!";
                resolve();
                return;
              }
              nonce++;
            }
            setTimeout(attempt, 0);
          };
          attempt();
        });
      } else if (data.type === 'pow_solution') {
        if (app.role === "sender") {
          const encoder = new TextEncoder();
          const hash = await crypto.subtle.digest("SHA-256", encoder.encode(app.powChallenge + data.nonce));
          const hashArray = new Uint8Array(hash);
          if (hashArray[0] === 0 && hashArray[1] === 0 && (hashArray[2] & 0xC0) === 0) {
            const statusEl = document.getElementById("connection-status");
            if (statusEl) {
              statusEl.innerHTML = `
                              <div class="w-2 h-2 rounded-full bg-green-400 shadow-[0_0_10px_rgba(74,222,128,0.5)]"></div>
                              Device Connected
                          `;
              statusEl.classList.remove("text-amber-400", "bg-amber-400/10", "border-amber-400/20");
              statusEl.classList.add("text-green-400", "bg-green-400/10", "border-green-400/20");
            }
            app.showToast("Receiver Connected (Secured)!", "success");
            const exportedPubKey = await crypto.subtle.exportKey("jwk", app.ecdhKeyPair.publicKey);
            app.conn.send({ type: "ecdh_exchange", pubKey: exportedPubKey });

          } else {
            app.conn.close();
          }
        }
        return;
      } else if (data.type === 'ecdsa_challenge') {
        try {
          const myChallenge = Math.random().toString(36).substring(2, 10);
          app.ecdsaChallenge = myChallenge;
          const signature = await app.signWithIdentity(data.challenge);
          app.conn.send({ type: 'ecdsa_solution', signature: Array.from(new Uint8Array(signature)), myChallenge: myChallenge });
        } catch (e) { app.conn.close(); }
        return;
      } else if (data.type === 'ecdsa_solution') {
        try {
          const sig = new Uint8Array(data.signature).buffer;
          const isValid = await app.verifyWithIdentity(app.connectedPeerPubKey, sig, app.ecdsaChallenge);
          if (isValid) {
            const mySig = await app.signWithIdentity(data.myChallenge);
            app.conn.send({ type: 'ecdsa_verify', signature: Array.from(new Uint8Array(mySig)) });
            app.finalizeSecretHandshake();
          } else { app.conn.close(); }
        } catch (e) { app.conn.close(); }
        return;
      } else if (data.type === 'ecdsa_verify') {
        try {
          const sig = new Uint8Array(data.signature).buffer;
          const isValid = await app.verifyWithIdentity(app.connectedPeerPubKey, sig, app.ecdsaChallenge);
          if (isValid) app.finalizeSecretHandshake();
          else app.conn.close();
        } catch (e) { app.conn.close(); }
        return;
      } else if (data.type === "ecdh_exchange") {
        try {
          const importedPubKey = await crypto.subtle.importKey(
            "jwk", data.pubKey, { name: "ECDH", namedCurve: "P-256" }, true, []
          );
          app.sharedSecret = await crypto.subtle.deriveKey(
            { name: "ECDH", public: importedPubKey },
            app.ecdhKeyPair.privateKey,
            { name: "AES-GCM", length: 256 },
            false,
            ["encrypt", "decrypt"]
          );

          if (app.role === "receiver") {
            const exportedMyPubKey = await crypto.subtle.exportKey("jwk", app.ecdhKeyPair.publicKey);
            app.conn.send({ type: "ecdh_exchange", pubKey: exportedMyPubKey });
            await app.generateFingerprint(importedPubKey);
            if (!app.isStealthConnection) {
              app.toggleTransferPopup(true);
              app.updateProgress(0, "Waiting for files...");
            }
          } else if (app.role === "sender") {
            app.showToast("E2EE Key Established!", "success");
            await app.generateFingerprint(importedPubKey);
            if (!app.isStealthConnection) {
              setTimeout(() => app.startFileTransfer(), 500);
            }
          }
        } catch (e) {
          console.error("ECDH Exchange Error", e);
          app.showToast("E2EE Handshake Failed", "error");
          app.conn.close();
        }
        return;
      } else if (data.type === "trust_request") {
        app.handleTrustRequest(data);
        return;
      } else if (data.type === "trust_accepted") {
        app.handleTrustAccepted(data);
        return;
      }

      if (data instanceof ArrayBuffer || data instanceof Uint8Array) {
        if (!app.receivedFileMeta) return;
        try {
          const payload = new Uint8Array(data);
          const iv = payload.slice(0, 12);
          const ciphertext = payload.slice(12);

          if (!app.sharedSecret) {
            console.error("No E2EE shared secret available to decrypt!");
            return;
          }

          const decrypted = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv }, app.sharedSecret, ciphertext
          );

          app.receivedFileParts.push(decrypted);
          app.receivedBytes += decrypted.byteLength;

          const now = Date.now();
          if (!app.lastReceiverUpdate) app.lastReceiverUpdate = 0;

          if (now - app.lastReceiverUpdate > 100 || app.receivedBytes >= app.receivedFileMeta.size) {
            const percent = Math.min(100, Math.round((app.receivedBytes / app.receivedFileMeta.size) * 100));
            const safeName = window.DOMPurify ? window.DOMPurify.sanitize(app.receivedFileMeta.name) : app.receivedFileMeta.name.replace(/</g, "&lt;").replace(/>/g, "&gt;");
            app.updateProgress(percent, `Receiving ${safeName}`);
            app.lastReceiverUpdate = now;
          }
        } catch (e) {
          console.error("Decryption failed", e);
          app.terminateTransferWithError("Data decryption failed! Connection might be compromised.");
        }
        return;
      }

      if (data.type === "file-start") {
        if (data.size > 1024 * 1024 * 512) {
          const safeName = window.DOMPurify ? window.DOMPurify.sanitize(data.name) : data.name.replace(/</g, "&lt;").replace(/>/g, "&gt;");
          if (!confirm(`Warning: Incoming file "${safeName}" is large (${app.formatSize(data.size)}). It might cause memory issues or crash the browser. Do you want to receive it anyway?`)) {
            app.showToast("File rejected due to size.", "warning");
            app.receivedFileMeta = null;
            return;
          }
        }
        app.receivedFileMeta = data;
        app.receivedFileParts = [];
        app.receivedBytes = 0;
        app.lastReceiverUpdate = 0;

        app.toggleTransferPopup(true);
        const safeName = window.DOMPurify ? window.DOMPurify.sanitize(data.name) : data.name.replace(/</g, "&lt;").replace(/>/g, "&gt;");
        app.updateProgress(0, `Receiving ${data.index + 1}/${data.totalFiles}: ${safeName}`);

        if (!app.receivedFilesList) app.receivedFilesList = [];
      } else if (data.type === "file-end") {
        app.updateProgress(100, "Processing...");
        const blob = new Blob(app.receivedFileParts, { type: app.receivedFileMeta.mime });

        const fileId = "sp_" + Date.now() + "_" + Math.random().toString(36).substr(2, 5);

        let fileRecord = {
          id: fileId,
          meta: app.receivedFileMeta,
        };

        if (app.dbReady) {
          app.saveToIndexedDB(fileId, blob);
          fileRecord.blob = null;
        } else {
          fileRecord.blob = blob;
        }

        app.receivedFilesList.push(fileRecord);
        app.isFileHeld = true;
        app.receivedFileParts = [];

        app.addFileToReceivedModal(fileRecord, app.receivedFilesList.length - 1);
      } else if (data.type === "batch-complete") {
        app.toggleTransferPopup(false);
        app.showToast("All files received!", "success");
        app.showReceivedModal();
      }
    });
  },

  dbReady: false,
  db: null,
  initDB: () => {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open("SharePeerDB", 2);
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains("files")) {
          db.createObjectStore("files");
        }
        if (!db.objectStoreNames.contains("keys")) {
          db.createObjectStore("keys");
        }
        if (!db.objectStoreNames.contains("peers")) {
          db.createObjectStore("peers", { keyPath: "publicKey" });
        }
      };
      request.onsuccess = async (e) => {
        app.db = e.target.result;
        app.dbReady = true;

        try {
          const transaction = app.db.transaction("files", "readwrite");
          transaction.objectStore("files").clear();
        } catch (err) { }

        await app.loadIdentityKey();
        await app.loadTrustedPeers();
        resolve();
      };
      request.onerror = (e) => {
        console.error("IndexedDB error", e);
        reject(e);
      };
    });
  },

  loadIdentityKey: async () => {
    return new Promise((resolve, reject) => {
      const transaction = app.db.transaction("keys", "readwrite");
      const store = transaction.objectStore("keys");
      const request = store.get("identityKey");

      request.onsuccess = async (e) => {
        if (e.target.result) {
          app.identityKeyPair = e.target.result;
          resolve();
        } else {
          try {
            app.identityKeyPair = await crypto.subtle.generateKey(
              { name: "ECDSA", namedCurve: "P-384" },
              false,
              ["sign", "verify"]
            );
            const putReq = store.put(app.identityKeyPair, "identityKey");
            putReq.onsuccess = () => resolve();
            putReq.onerror = () => reject();
          } catch (err) {
            console.error(err);
            reject(err);
          }
        }
      };
      request.onerror = () => reject();
    });
  },

  loadTrustedPeers: async () => {
    return new Promise((resolve, reject) => {
      const transaction = app.db.transaction("peers", "readonly");
      const store = transaction.objectStore("peers");
      const request = store.getAll();

      request.onsuccess = (e) => {
        app.trustedPeers = e.target.result || [];
        app.renderTrustedPeers();
        app.startStealthListeners();
        resolve();
      };
      request.onerror = () => reject();
    });
  },

  saveTrustedPeer: async (publicKeyStr, name) => {
    return new Promise((resolve, reject) => {
      const transaction = app.db.transaction("peers", "readwrite");
      const store = transaction.objectStore("peers");
      const peerData = { publicKey: publicKeyStr, name: name, addedAt: Date.now() };
      const request = store.put(peerData);
      request.onsuccess = () => {
        const existing = app.trustedPeers.findIndex(p => p.publicKey === publicKeyStr);
        if (existing > -1) app.trustedPeers[existing] = peerData;
        else app.trustedPeers.push(peerData);
        app.renderTrustedPeers();
        resolve();
      };
      request.onerror = () => reject();
    });
  },

  deleteTrustedPeer: async (publicKeyStr) => {
    return new Promise((resolve, reject) => {
      const transaction = app.db.transaction("peers", "readwrite");
      const store = transaction.objectStore("peers");
      const request = store.delete(publicKeyStr);
      request.onsuccess = () => {
        app.trustedPeers = app.trustedPeers.filter(p => p.publicKey !== publicKeyStr);
        app.renderTrustedPeers();
        app.startStealthListeners();
        resolve();
      };
      request.onerror = () => reject();
    });
  },

  generateStealthPeerId: async (publicKeyStr, role, stepOffset = 0) => {
    const timeStep = Math.floor(Date.now() / 600000) + stepOffset;
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      "raw", enc.encode(publicKeyStr + (role === 'receiver' ? '-rcv' : '-snd')), { name: "PBKDF2" }, false, ["deriveBits", "deriveKey"]
    );
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt: enc.encode(timeStep.toString()), iterations: 10000, hash: "SHA-256" },
      keyMaterial, 128
    );
    const hashHex = Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('');
    return `spf-stealth-${hashHex}`;
  },

  startStealthListeners: async (skipPrompt = false) => {
    if (app.role === "sender") return;

    if (app.isTransferring || (app.conn && app.conn.open)) return;

    if (app.stealthRefreshInterval) clearInterval(app.stealthRefreshInterval);
    app.stealthRefreshInterval = setInterval(() => {
      app.startStealthListeners(true);
    }, 10 * 60 * 1000);

    app.stealthListeners.forEach(p => { if (!p.destroyed) p.destroy(); });
    app.stealthListeners = [];

    let peersToListen = app.trustedPeers;
    if (peersToListen.length > 5 && !skipPrompt) {
      if (!confirm(`You have ${peersToListen.length} saved devices. Listening to all at once may use more resources.\n\nDo you want to listen to all of them simultaneously? (Checking 'Cancel' will queue them and listen in rotation)`)) {
        app.stealthQueueIndex = 0;
        app.startStealthRotation();
        return;
      }
    }

    app._listenToPeers(peersToListen);
  },

  startStealthRotation: () => {
    if (app.stealthRotationInterval) clearInterval(app.stealthRotationInterval);

    const listenNextBatch = () => {
      if (app.isTransferring || (app.conn && app.conn.open)) return;

      app.stealthListeners.forEach(p => { if (!p.destroyed) p.destroy(); });
      app.stealthListeners = [];

      const batch = app.trustedPeers.slice(app.stealthQueueIndex, app.stealthQueueIndex + 5);
      app._listenToPeers(batch);

      app.stealthQueueIndex += 5;
      if (app.stealthQueueIndex >= app.trustedPeers.length) app.stealthQueueIndex = 0;
    };

    listenNextBatch();
    app.stealthRotationInterval = setInterval(listenNextBatch, 15000);
  },

  _listenToPeers: (peers) => {
    peers.forEach(async (peer) => {
      const stealthId = await app.generateStealthPeerId(peer.publicKey, 'receiver', app.clockOffset || 0);
      const stealthPeer = new Peer(stealthId, {
        debug: 1,
        config: { iceServers: [{ url: "stun:stun.l.google.com:19302" }] },
      });

      stealthPeer.on("open", (id) => console.log("Stealth listening on: " + id));

      stealthPeer.on("connection", (conn) => {
        if (app.conn && app.conn.open) {
          conn.close();
          return;
        }
        console.log("Incoming stealth connection...");
        app.conn = conn;
        app.isStealthConnection = true;
        app.connectedPeerPubKey = peer.publicKey;
        app.connectedPeerName = peer.name;
        app.setupConnectionHandlers(conn);
      });

      stealthPeer.on("error", (err) => {
        if (err.type === "unavailable-id") { }
      });
      app.stealthListeners.push(stealthPeer);
    });
  },

  manualSyncClock: async () => {
    const choice = confirm("Cihazınızı göremiyor musunuz? Saat farkından dolayı bağlantı kurulamıyor olabilir. Eski bağlantı ID'lerini (10 dk öncesi) dinlemek ister misiniz?\n\nTamam: -10 dk (Geçmiş)\nİptal: Normal (Şu an)");
    if (choice) {
      app.clockOffset = -1;
      app.showToast("Listening to previous time window...", "info");
    } else {
      app.clockOffset = 0;
      app.showToast("Listening to current time window...", "info");
    }
    app.startStealthListeners(true);
  },

  connectToStealthPeer: async (trustedPeer) => {
    app.showAuthModal("Connecting to Trusted Peer...");

    let peerInst = new Peer({ debug: 1, config: { iceServers: [{ url: "stun:stun.l.google.com:19302" }] } });

    const attemptConnect = async (offset) => {
      const stealthId = await app.generateStealthPeerId(trustedPeer.publicKey, 'receiver', offset);
      const conn = peerInst.connect(stealthId, { reliable: true });
      let connected = false;

      conn.on("open", () => {
        connected = true;
        app.conn = conn;
        app.isStealthConnection = true;
        app.connectedPeerPubKey = trustedPeer.publicKey;
        app.connectedPeerName = trustedPeer.name;
        app.showAuthModal("Authenticating...");
        app.setupConnectionHandlers(conn);
      });

      conn.on("error", () => { if (!connected) handleFail(offset); });
      conn.on("close", () => { if (!connected) handleFail(offset); });

      setTimeout(() => {
        if (!connected && !conn.open) { conn.close(); handleFail(offset); }
      }, 5000);

      function handleFail(off) {
        if (off === 0) attemptConnect(-1);
        else {
          app.hideAuthModal();
          app.showToast("Could not find peer. They might be offline.", "error");
          peerInst.destroy();
        }
      }
    };

    if (peerInst.open) attemptConnect(0);
    else peerInst.on("open", () => attemptConnect(0));
  },

  renderTrustedPeers: () => {
    const list = document.getElementById("trusted-peers-list");
    if (!list) return;

    list.innerHTML = "";
    if (app.trustedPeers.length === 0) {
      list.innerHTML = "<p class='text-slate-500 text-sm'>No saved peers</p>";
      return;
    }

    app.trustedPeers.forEach(peer => {
      const div = document.createElement("div");
      div.className = "flex items-center justify-between p-3 bg-slate-800 rounded-lg border border-slate-700";
      const safeName = window.DOMPurify ? window.DOMPurify.sanitize(peer.name) : peer.name;
      div.innerHTML = `
          <div class="flex items-center gap-3">
             <div class="w-8 h-8 rounded-full bg-emerald-500/20 flex items-center justify-center">
                 <svg class="w-4 h-4 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
             </div>
             <div class="text-sm font-medium text-slate-200">${safeName}</div>
          </div>
          <div class="flex gap-2">
             <button onclick="app.connectToStealthPeer(app.trustedPeers.find(p => p.publicKey === '${peer.publicKey}'))" class="text-blue-400 hover:text-blue-300 text-xs bg-blue-500/10 px-2 py-1 rounded">Connect</button>
             <button onclick="app.deleteTrustedPeer('${peer.publicKey}')" class="text-red-400 hover:text-red-300 text-xs bg-red-500/10 px-2 py-1 rounded">Delete</button>
          </div>
       `;
      list.appendChild(div);
    });

    const syncDiv = document.createElement('div');
    syncDiv.className = "mt-2 flex self-center justify-center w-full";
    syncDiv.innerHTML = `<button onclick="app.manualSyncClock()" class="text-amber-400 hover:text-amber-300 text-xs flex items-center gap-1 transition">
      <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
      Cihazınızı göremiyor musunuz?
    </button>`;
    list.appendChild(syncDiv);
  },

  saveToIndexedDB: (id, blob) => {
    if (!app.db) return;
    const transaction = app.db.transaction("files", "readwrite");
    const store = transaction.objectStore("files");
    store.put(blob, id);
  },

  getFromIndexedDB: (id) => {
    return new Promise((resolve, reject) => {
      if (!app.db) {
        resolve(null);
        return;
      }
      const transaction = app.db.transaction("files", "readonly");
      const store = transaction.objectStore("files");
      const request = store.get(id);
      request.onsuccess = (e) => resolve(e.target.result);
      request.onerror = (e) => reject(e);
    });
  },

  addFileToReceivedModal: (fileRecord, index) => {
    const listContainer = document.getElementById("received-files-list");
    const filename = fileRecord.meta.name;
    const safeName = window.DOMPurify ? window.DOMPurify.sanitize(filename) : filename.replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const isClipboard = filename.endsWith(".clipboard");
    const ext = isClipboard ? "TXT" : filename.split(".").pop().substring(0, 4);

    const el = document.createElement("div");
    el.className = "bg-slate-800/50 rounded-lg p-3 border border-slate-700 flex flex-col md:flex-row items-center justify-between gap-3 mb-2";

    let actions = `
            <button onclick="app.downloadFile(${index})" class="bg-blue-600 text-white hover:bg-blue-500 px-4 py-2 rounded-lg transition shadow-sm text-xs font-medium flex-shrink-0 w-full md:w-auto">
                Download
            </button>
    `;

    if (isClipboard) {
      actions = `
            <div class="flex items-center gap-2 w-full md:w-auto mt-2 md:mt-0">
                <button onclick="app.copyClipboardFile(${index})" class="bg-indigo-600 text-white hover:bg-indigo-500 px-4 py-2 rounded-lg transition shadow-sm text-xs font-medium flex-1 md:flex-none whitespace-nowrap">
                    Copy
                </button>
                <button onclick="app.downloadFile(${index})" class="bg-slate-700 text-slate-300 hover:bg-slate-600 px-4 py-2 rounded-lg transition shadow-sm text-xs font-medium flex-1 md:flex-none">
                    Download
                </button>
            </div>
        `;
    }

    el.innerHTML = `
            <div class="flex items-center gap-3 overflow-hidden w-full">
                <div class="bg-slate-700 p-2 rounded text-slate-300 font-bold uppercase text-xs h-10 w-10 flex items-center justify-center flex-shrink-0">
                    ${ext}
                </div>
                <div class="overflow-hidden text-left flex-grow">
                    <h4 class="text-white text-sm font-medium truncate max-w-[150px] md:max-w-[200px]" title="${safeName}">${safeName}</h4>
                    <p class="text-slate-500 text-[10px]">${app.formatSize(fileRecord.meta.size)}</p>
                </div>
            </div>
            ${actions}
        `;
    listContainer.appendChild(el);
  },

  copyClipboardFile: async (index) => {
    const fileRecord = app.receivedFilesList[index];
    if (!fileRecord) return;
    try {
      let targetBlob = fileRecord.blob;
      if (!targetBlob && fileRecord.id) {
        targetBlob = await app.getFromIndexedDB(fileRecord.id);
      }
      if (!targetBlob) {
        app.showToast("File data lost or unavailable.", "error");
        return;
      }
      const text = await targetBlob.text();
      await navigator.clipboard.writeText(text);
      app.showToast("Copied to clipboard!", "success");
    } catch (err) {
      console.error("Copy failed", err);
      app.showToast("Failed to copy to clipboard.", "error");
    }
  },

  showReceivedModal: () => {
    const modal = document.getElementById("file-received-modal");
    modal.classList.remove("hidden");
    modal.classList.add("flex");
    const trustBtn = document.getElementById('btn-receiver-trust');
    if (trustBtn) {
      trustBtn.style.display = app.isStealthConnection ? 'none' : 'block';
    }
  },

  showTrustedPeers: () => {
    app.renderTrustedPeers();
    const modal = document.getElementById("trusted-peers-modal");
    modal.classList.remove("hidden");
    setTimeout(() => {
      modal.classList.remove("opacity-0");
      const div = modal.querySelector("div");
      div.classList.remove("scale-95");
      div.classList.add("scale-100");
    }, 10);
  },

  hideTrustedPeers: () => {
    const modal = document.getElementById("trusted-peers-modal");
    modal.classList.add("opacity-0");
    const div = modal.querySelector("div");
    div.classList.remove("scale-100");
    div.classList.add("scale-95");
    setTimeout(() => {
      modal.classList.add("hidden");
    }, 300);
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
      app.checkWakeLock();
    } else {
      p.classList.add("opacity-0");
      c.classList.remove("scale-100");
      c.classList.add("scale-95");
      setTimeout(() => {
        p.classList.add("hidden");
      }, 300);
      app.isTransferring = false;
      app.releaseWakeLock();
    }
  },

  updateProgress: (val, text) => {
    const pBar = document.getElementById("transfer-progress-bar");
    if (pBar) pBar.style.width = val + "%";
    const stxt = document.getElementById("transfer-status-text");
    if (stxt && text) stxt.innerText = text;
  },

  getExportedIdentityKey: async () => {
    if (!app.identityKeyPair) return null;
    const jwk = await crypto.subtle.exportKey("jwk", app.identityKeyPair.publicKey);
    return JSON.stringify(jwk);
  },

  signWithIdentity: async (dataStr) => {
    const enc = new TextEncoder();
    return await crypto.subtle.sign(
      { name: "ECDSA", hash: { name: "SHA-384" } },
      app.identityKeyPair.privateKey,
      enc.encode(dataStr)
    );
  },

  verifyWithIdentity: async (pubKeyStr, signatureBuf, dataStr) => {
    try {
      const enc = new TextEncoder();
      const jwk = JSON.parse(pubKeyStr);
      const pubKey = await crypto.subtle.importKey(
        "jwk", jwk, { name: "ECDSA", namedCurve: "P-384" }, true, ["verify"]
      );
      return await crypto.subtle.verify(
        { name: "ECDSA", hash: { name: "SHA-384" } },
        pubKey,
        signatureBuf,
        enc.encode(dataStr)
      );
    } catch (err) { return false; }
  },

  finalizeSecretHandshake: async () => {
    app.hideAuthModal();
    app.showToast("Stealth Authentication Successful!", "success");

    const statusEl = document.getElementById("connection-status");
    if (statusEl) {
      statusEl.innerHTML = `
           <div class="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.5)]"></div>
           <svg class="w-4 h-4 text-emerald-400" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/></svg>
           <span class="font-bold text-emerald-400" title="Şifreli & Doğrulanmış Cihaz">${window.DOMPurify ? window.DOMPurify.sanitize(app.connectedPeerName) : app.connectedPeerName}</span>
       `;
      statusEl.classList.remove("text-amber-400", "bg-amber-400/10", "border-amber-400/20");
      statusEl.classList.add("text-emerald-400", "bg-emerald-400/10", "border-emerald-400/20");
    }

    const exportedPubKey = await crypto.subtle.exportKey("jwk", app.ecdhKeyPair.publicKey);
    app.conn.send({ type: "ecdh_exchange", pubKey: exportedPubKey });

    if (app.role === 'sender') {
      setTimeout(() => app.startFileTransfer(), 500);
    } else {
      app.toggleTransferPopup(true);
      app.updateProgress(0, "Waiting for files...");
    }
  },

  showAuthModal: (msg) => {
    app.requestWakeLock();
    app.toggleTransferPopup(true);
    const pBar = document.getElementById("transfer-progress-bar");
    if (pBar) pBar.parentElement.style.display = 'none';
    app.updateProgress(0, msg);
    const tit = document.querySelector("#transfer-content h3");
    if (tit) tit.innerText = "Securing Connection...";
  },

  hideAuthModal: () => {
    app.releaseWakeLock();
    const pBar = document.getElementById("transfer-progress-bar");
    if (pBar) pBar.parentElement.style.display = 'block';
    const tit = document.querySelector("#transfer-content h3");
    if (tit) tit.innerText = "Transferring Files...";
  },

  sendTrustRequest: async () => {
    const rootCont = document.getElementById('trust-prompt-container');
    if (rootCont) rootCont.innerHTML = `<span class="text-sm text-amber-400">Request Sent. Waiting...</span>`;

    app.conn.send({
      type: "trust_request",
      pubKey: await app.getExportedIdentityKey(),
      name: prompt("Enter a name for this device so you can identify it:", "Peer_" + Math.floor(Math.random() * 10000)) || "Peer"
    });
  },

  handleTrustRequest: (data) => {
    const rootCont = document.getElementById('trust-prompt-container') || document.getElementById('file-received-modal');
    if (!rootCont) return;

    const div = document.createElement('div');
    div.className = "mt-4 p-4 bg-amber-500/10 border border-amber-500/30 rounded-xl";
    div.innerHTML = `
      <p class="text-amber-400 text-sm font-bold mb-2">Peer wants to save you as Trusted Device</p>
      <div class="flex gap-2">
        <button onclick="app.acceptTrustRequest('${btoa(data.pubKey)}', '${data.name}')" class="bg-amber-600 hover:bg-amber-500 text-white px-3 py-1 rounded text-xs font-bold w-full">Accept & Add</button>
      </div>
    `;

    if (document.getElementById('trust-prompt-container')) {
      document.getElementById('trust-prompt-container').innerHTML = '';
      document.getElementById('trust-prompt-container').appendChild(div);
    } else {
      rootCont.querySelector('.grid').insertAdjacentElement('beforebegin', div);
    }
  },

  acceptTrustRequest: async (b64PubKey, peerName) => {
    const pubKey = atob(b64PubKey);
    await app.saveTrustedPeer(pubKey, peerName);
    const myName = prompt("Enter your name for this device (so they know you):", "MyDevice") || "MyDevice";
    app.conn.send({
      type: "trust_accepted",
      pubKey: await app.getExportedIdentityKey(),
      name: myName
    });
    app.showToast("Added to Trusted Devices!", "success");
    const container = document.getElementById('trust-prompt-container') || document.getElementById('file-received-modal');
    const amberBox = container.querySelector('.bg-amber-500\\/10');
    if (amberBox) amberBox.innerHTML = '<span class="text-emerald-400 text-sm font-bold">Device added to trusted list.</span>';
  },

  handleTrustAccepted: async (data) => {
    await app.saveTrustedPeer(data.pubKey, data.name);
    app.showToast("Peer accepted your device! Added to Trusted.", "success");
    const rootCont = document.getElementById('trust-prompt-container');
    if (rootCont) rootCont.innerHTML = '<span class="text-emerald-400 text-sm font-bold">Verified & Added!</span>';
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

  downloadFile: async (index) => {
    const fileRecord = app.receivedFilesList[index];
    if (!fileRecord) return;

    let targetBlob = fileRecord.blob;
    if (!targetBlob && fileRecord.id) {
      targetBlob = await app.getFromIndexedDB(fileRecord.id);
    }
    if (!targetBlob) {
      app.showToast("File data lost or unavailable.", "error");
      return;
    }

    const url = URL.createObjectURL(targetBlob);
    const a = document.createElement("a");
    a.href = url;

    let dlName = fileRecord.meta.name;
    if (dlName.endsWith(".clipboard")) {
      dlName = dlName.replace(".clipboard", ".txt");
    }
    a.download = dlName;

    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);

    app.showToast("Download started", "success");
  },

  discardFile: () => {
    app.isFileHeld = false;
    app.receivedFilesList = [];
    app.receivedFileParts = [];
    app.receivedFileMeta = null;

    if (app.dbReady && app.db) {
      const transaction = app.db.transaction("files", "readwrite");
      transaction.objectStore("files").clear();
    }

    document.getElementById("received-files-list").innerHTML = "";

    document.getElementById("file-received-modal").classList.add("hidden");
    document.getElementById("file-received-modal").classList.remove("flex");

    app.goHome();
  },

  generateFingerprint: async (importedPubKey) => {
    try {
      const bits = await crypto.subtle.deriveBits(
        { name: "ECDH", public: importedPubKey },
        app.ecdhKeyPair.privateKey,
        32
      );
      const view = new DataView(bits);
      const num = view.getUint32(0) % 1000000;
      const code = num.toString().padStart(6, '0');
      const formattedCode = code.substring(0, 3) + " " + code.substring(3, 6);

      const el = document.getElementById("security-code-display");
      const valEl = document.getElementById("security-code-value");
      if (el && valEl) {
        valEl.innerText = formattedCode;
        el.classList.remove("hidden");
      }
      return formattedCode;
    } catch (e) {
      console.error("Fingerprint generation failed", e);
    }
  },

  terminateTransferWithError: (msg) => {
    app.showToast(msg, "error");
    app.isTransferring = false;

    if (app.conn) {
      app.conn.close();
    }

    app.receivedFileParts = [];
    app.receivedBytes = 0;

    if (app.dbReady && app.db) {
      const transaction = app.db.transaction("files", "readwrite");
      transaction.objectStore("files").clear();
    }

    app.toggleTransferPopup(false);
    app.resetState();
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
    if (!container) return;

    const el = document.createElement("div");

    let bg = "bg-slate-900/80";
    let border = "border-white/10";
    let icon = "";
    let shadow = "shadow-black/50";

    if (type === "success") {
      border = "border-emerald-500/50";
      shadow = "shadow-emerald-500/10";
      icon = `
                <div class="flex-shrink-0 w-8 h-8 rounded-full bg-emerald-500/20 flex items-center justify-center">
                    <svg class="w-4 h-4 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7" />
                    </svg>
                </div>
            `;
    } else if (type === "error") {
      bg = "bg-red-900/40";
      border = "border-red-500/50";
      shadow = "shadow-red-500/10";
      icon = `
                <div class="flex-shrink-0 w-8 h-8 rounded-full bg-red-500/20 flex items-center justify-center">
                    <svg class="w-4 h-4 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                </div>
            `;
    } else {
      border = "border-blue-500/50";
      shadow = "shadow-blue-500/10";
      icon = `
                <div class="flex-shrink-0 w-8 h-8 rounded-full bg-blue-500/20 flex items-center justify-center">
                    <svg class="w-4 h-4 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                </div>
            `;
    }

    el.className = `toast backdrop-blur-xl ${bg} ${border} border ${shadow} p-3 pl-4 pr-5 rounded-2xl text-white shadow-2xl flex items-center gap-4 min-w-[320px] pointer-events-auto ring-1 ring-white/10`;
    el.innerHTML = `
            ${icon}
            <div class="text-sm font-medium pr-2 text-slate-100">${message}</div>
            <button class="ml-auto text-slate-500 hover:text-white transition-colors" onclick="this.parentElement.remove()">
                <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
            </button>
        `;

    container.appendChild(el);

    requestAnimationFrame(() => {
      el.classList.add("show");
    });

    setTimeout(() => {
      if (!el.parentElement) return;
      el.classList.remove("show");

      setTimeout(() => {
        if (el.parentElement) el.remove();
      }, 400);
    }, 4500);
  },
};

document.addEventListener("DOMContentLoaded", async () => {
  await app.initDB();
  app.init();
});
