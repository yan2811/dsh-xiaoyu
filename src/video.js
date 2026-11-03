import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs";

const run = promisify(execFile);

/**
 * WAV → MP4（波形可视化 + 原声）。
 *
 * 为什么绕这一圈：微信的 iLink 机器人平台**不接受机器人发语音条**。
 * 我们把包结构逐字段镜像真实入站语音、并采用参考实现的确切取值后，
 * API 依然返回 200 + message_id 却不在微信里渲染 —— 断在平台侧。
 *
 * 但微信**接受视频消息**，而 SDK 的视频发送路径是完整实现的。
 * 所以把语音做成一个带波形的视频，微信里就是一个可点开、内联播放、
 * 有声音的气泡 —— 比文件卡片接近"语音条"得多。
 *
 * 返回 MP4 路径；失败返回 null（调用方应退回发文件）。
 */
export async function wavToVideo(wavPath) {
  const outPath = path.join(
    path.dirname(wavPath),
    path.basename(wavPath, ".wav") + ".mp4"
  );

  const args = [
    "-y",
    "-nostdin", // 不加的话 ffmpeg 可能去读 stdin，把调用方的输入吃掉
    "-hide_banner",
    "-loglevel", "error",
    "-i", wavPath,
    // showwaves 直接吃音频画出实时波形，不需要任何图片素材。
    // 浅蓝波形画在默认黑底上，一眼能看出"这是条语音"。
    "-filter_complex",
    "[0:a]showwaves=s=480x480:mode=cline:rate=25:colors=0x7EC8E3|0xB0E0E6[v]",
    "-map", "[v]",
    "-map", "0:a",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-pix_fmt", "yuv420p", // 不加的话部分播放器解不了
    "-r", "25",
    "-c:a", "aac",
    "-b:a", "64k",
    "-ar", "44100",
    "-ac", "1",
    "-shortest",
    outPath,
  ];

  try {
    await run("ffmpeg", args, { timeout: 90000 });
    const size = fs.statSync(outPath).size;
    console.log(`[视频] 合成 ${(size / 1024).toFixed(0)} KB -> ${path.basename(outPath)}`);
    return outPath;
  } catch (e) {
    console.error("[视频] ffmpeg 失败:", (e.stderr || e.message || "").slice(0, 300));
    try { fs.unlinkSync(outPath); } catch {}
    return null;
  }
}
