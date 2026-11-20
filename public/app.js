const $ = id => document.getElementById(id);
let uploadedImageId = null;

async function api(url, options) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok && response.status !== 503) throw new Error(data.error || "Request failed");
  return { response, data };
}

async function refreshStatus() {
  try {
    const [{data:health},{data:models}] = await Promise.all([
      api("/api/health"), api("/api/models")
    ]);
    $("serverState").textContent = "Local server online";
    $("serverState").style.color = "var(--accent)";
    $("serverValue").textContent = "Online";
    $("engineValue").textContent = health.inference.available ? "Ready" : "Not installed";
    $("modelValue").textContent = models.models.length + " file(s)";
    $("jobStatus").textContent = health.inference.reason || "Inference engine ready.";
  } catch (error) {
    $("serverState").textContent = "Offline";
    $("serverValue").textContent = "Offline";
    $("jobStatus").textContent = error.message;
  }
}

$("imageInput").addEventListener("change", async event => {
  const file = event.target.files[0];
  if (!file) return;
  if (file.size > 15 * 1024 * 1024) {
    $("uploadStatus").textContent = "Image exceeds the 15 MB limit.";
    return;
  }
  $("preview").src = URL.createObjectURL(file);
  $("preview").hidden = false;
  $("dropText").hidden = true;
  $("uploadStatus").textContent = "Uploading image…";
  const form = new FormData();
  form.append("image", file);
  try {
    const {data} = await api("/api/upload", {method:"POST",body:form});
    uploadedImageId = data.imageId;
    $("uploadStatus").textContent = file.name + " · " + (file.size / 1024 / 1024).toFixed(2) + " MB · stored locally";
    $("generate").disabled = false;
  } catch (error) {
    $("uploadStatus").textContent = error.message;
    uploadedImageId = null;
    $("generate").disabled = true;
  }
});

$("generate").addEventListener("click", async () => {
  if (!uploadedImageId) return;
  $("generate").disabled = true;
  $("jobStatus").textContent = "Checking local inference backend…";
  try {
    const {response,data} = await api("/api/jobs", {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({imageId:uploadedImageId,prompt:$("prompt").value,frames:Number($("frames").value)})
    });
    $("jobStatus").textContent = data.error || (response.ok ? "Job started." : "Backend unavailable.");
  } catch (error) {
    $("jobStatus").textContent = error.message;
  } finally {
    $("generate").disabled = false;
  }
});

refreshStatus();

function fmtBytes(value) {
  if (!Number.isFinite(value) || value < 0) return "Unknown";
  if (value < 1024) return value.toFixed(0) + " B";
  const units = ["KB", "MB", "GB", "TB"];
  let n = value / 1024, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return n.toFixed(1) + " " + units[i];
}
function fmtTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "Calculating…";
  if (seconds < 60) return Math.ceil(seconds) + " sec left";
  const mins = Math.ceil(seconds / 60);
  if (mins < 60) return mins + " min left";
  return Math.floor(mins / 60) + "h " + (mins % 60) + "m left";
}
function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
async function refreshModels() {
  try {
    const {data} = await api("/api/models");
    $("modelValue").textContent = data.models.length + " file(s)";
    const list = $("modelList");
    list.replaceChildren();
    if (!data.models.length) {
      list.append(make("div", "empty-state", "No model files stored yet."));
      return;
    }
    for (const model of data.models) {
      const card = make("div", "model-card");
      const top = make("div", "model-top");
      top.append(make("div", "model-name", model.name), make("div", "model-size", fmtBytes(model.bytes)));
      const actions = make("div", "card-actions");
      const remove = make("button", "danger-button", "Delete");
      remove.addEventListener("click", async () => {
        if (!confirm("Delete " + model.name + " from this device?")) return;
        remove.disabled = true;
        try {
          await api("/api/models/" + encodeURIComponent(model.name), {method:"DELETE"});
          await refreshModels();
        } catch (error) {
          alert(error.message);
          remove.disabled = false;
        }
      });
      actions.append(remove);
      card.append(top, actions);
      list.append(card);
    }
  } catch (error) {
    $("modelList").replaceChildren(make("div", "empty-state", error.message));
  }
}
async function refreshDownloads() {
  try {
    const {data} = await api("/api/downloads");
    const list = $("downloadList");
    list.replaceChildren();
    const downloads = data.downloads.slice().reverse();
    if (!downloads.length) {
      list.append(make("div", "empty-state", "No downloads yet."));
      return;
    }
    for (const item of downloads) {
      const card = make("div", "download-card");
      const top = make("div", "download-top");
      top.append(make("div", "download-name", item.name), make("div", "download-state", item.status));
      const track = make("div", "progress-track");
      const fill = make("div", "progress-fill");
      fill.style.width = (item.progress === null ? (item.status === "completed" ? 100 : 0) : item.progress) + "%";
      track.append(fill);
      const meta = make("div", "download-meta");
      const amount = item.total ? fmtBytes(item.bytes) + " / " + fmtBytes(item.total) : fmtBytes(item.bytes) + " downloaded";
      meta.append(make("span", "", amount), make("span", "", item.status === "completed" ? "Complete" : item.status === "downloading" ? fmtTime(item.eta) : item.status === "queued" ? "Starting…" : ""));
      const speed = make("div", "download-meta");
      speed.append(make("span", "", item.status === "downloading" ? fmtBytes(item.speed) + "/s" : ""), make("span", "", item.progress === null ? "Size unknown" : item.progress.toFixed(1) + "%"));
      card.append(top, track, meta, speed);
      if (item.error) card.append(make("div", "download-error", item.error));
      if (["queued", "downloading"].includes(item.status)) {
        const actions = make("div", "card-actions");
        const cancel = make("button", "danger-button", "Cancel");
        cancel.addEventListener("click", async () => {
          cancel.disabled = true;
          try { await api("/api/downloads/" + item.id, {method:"DELETE"}); await refreshDownloads(); }
          catch (error) { alert(error.message); cancel.disabled = false; }
        });
        actions.append(cancel);
        card.append(actions);
      }
      list.append(card);
    }
  } catch (error) {
    $("downloadList").replaceChildren(make("div", "empty-state", error.message));
  }
}
$("downloadModel").addEventListener("click", async () => {
  const url = $("modelUrl").value.trim();
  if (!url) { $("modelUrl").focus(); return; }
  const button = $("downloadModel");
  button.disabled = true;
  button.textContent = "Starting download…";
  try {
    await api("/api/downloads", {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({url,filename:$("modelFilename").value.trim()})
    });
    $("modelUrl").value = "";
    $("modelFilename").value = "";
    await refreshDownloads();
  } catch (error) {
    alert(error.message);
  } finally {
    button.disabled = false;
    button.innerHTML = 'Download to device <span>↓</span>';
  }
});
$("refreshModels").addEventListener("click", refreshModels);
refreshModels();
refreshDownloads();
setInterval(refreshDownloads, 1000);
