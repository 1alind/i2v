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
