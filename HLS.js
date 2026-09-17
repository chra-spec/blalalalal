<script src="https://cdn.jsdelivr.net/npm/hls.js@1"></script>
<script>
fetch("https://blalalalal-3.onrender.com/api/ext/stream?id=21355&ep=1&key=anime_ext_2026_kwwn")
  .then(r => r.json())
  .then(data => {
    const video = document.getElementById("video");
    if (Hls.isSupported()) {
      const hls = new Hls();
      hls.loadSource("https://blalalalal-3.onrender.com" + data.proxyUrl);
      hls.attachMedia(video);
    }
  });
</script>
