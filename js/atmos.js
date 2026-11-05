(function () {
  "use strict";

  var canvas = document.getElementById("atmos");
  if (!canvas) return;

  var ctx = canvas.getContext("2d");
  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var TILE = 256;
  var tile = null;
  var pattern = null;
  var w = 0, h = 0, dpr = 1;

  function makeTile() {
    var c = document.createElement("canvas");
    c.width = c.height = TILE;
    var g = c.getContext("2d");
    var img = g.createImageData(TILE, TILE);
    var seed = 59;
    var rnd = function () {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (var i = 0; i < img.data.length; i += 4) {
      var v = rnd() * 255;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    return c;
  }

  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    w = window.innerWidth;
    h = window.innerHeight;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
  }

  var scratch = null;
  var last = 0;

  function draw() {
    if (!tile) {
      tile = makeTile();
      pattern = ctx.createPattern(tile, "repeat");
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    var ox = Math.random() * TILE;
    var oy = Math.random() * TILE;
    var flick = 0.88 + Math.random() * 0.24;

    ctx.globalAlpha = 0.045 * flick;
    ctx.globalCompositeOperation = "overlay";
    ctx.save();
    ctx.translate(-ox, -oy);
    ctx.fillStyle = pattern;
    ctx.fillRect(0, 0, w + TILE, h + TILE);
    ctx.restore();

    if (!scratch && Math.random() < 0.055) {
      scratch = {
        x: Math.random() * w,
        life: 2 + Math.floor(Math.random() * 4),
        a: 0.035 + Math.random() * 0.045,
      };
    }
    if (scratch) {
      ctx.globalAlpha = scratch.a;
      ctx.globalCompositeOperation = "lighter";
      ctx.fillStyle = "#f1e9dd";
      ctx.fillRect(scratch.x, 0, 1, h);
      if (--scratch.life <= 0) scratch = null;
    }

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }

  function loop(t) {
    if (t - last > 75) {
      draw();
      last = t;
    }
    requestAnimationFrame(loop);
  }

  resize();
  window.addEventListener("resize", function () {
    resize();
    if (reduce) draw();
  });

  if (reduce) {
    draw();
    return;
  }
  requestAnimationFrame(loop);
})();
