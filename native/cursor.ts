import { setCursor, type CursorImage } from "starhermit:input";
import { OffscreenCanvas } from "starhermit:canvas";

let cursor: CursorImage | null = null;

export function showCursor(): void {
  if (!cursor) {
    const canvas = new OffscreenCanvas(32, 32);
    const ctx = canvas.getContext("2d");
    if (!ctx) { setCursor("default"); return; }
    ctx.beginPath();
    ctx.moveTo(3, 2);
    ctx.lineTo(3, 25);
    ctx.lineTo(9, 19);
    ctx.lineTo(14, 29);
    ctx.lineTo(18, 27);
    ctx.lineTo(13, 17);
    ctx.lineTo(22, 17);
    ctx.closePath();
    ctx.lineJoin = "round";
    ctx.lineWidth = 4;
    ctx.strokeStyle = "#1a1f2e";
    ctx.stroke();
    ctx.fillStyle = "#6ea8ff";
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(6, 7);
    ctx.lineTo(6, 19);
    ctx.lineTo(9, 16);
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#ffffff";
    ctx.stroke();
    cursor = { image: ctx.getImageData(0, 0, 32, 32), hotspot: [3, 2], fallback: "default" };
  }
  setCursor(cursor);
}
