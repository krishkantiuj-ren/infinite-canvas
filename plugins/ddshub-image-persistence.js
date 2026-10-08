// Model call script for deployed canvases using the DDShub task proxy.
const path = images.length ? "/images/edits" : "/images/generations";
const body = {
  model, prompt, n: params.count || 1,
  size: params.size || "auto", quality: params.quality || "high",
  output_format: "png", response_format: "b64_json",
  ...(images.length ? { images } : {}),
};
const submitted = await http.post(path, body);
const result = submitted.data ? submitted : await poll(
  () => http.get(`${path}/tasks/${encodeURIComponent(submitted.id)}`),
  (value) => {
    if (!value) return null;
    if (value.status === "queued" || value.status === "running") return null;
    if (value.error) throw new Error(value.error.message || String(value.error));
    return value;
  },
  { intervalMs: 2500, timeoutMs: 600000 },
);
if (!Array.isArray(result.data) || !result.data.length) throw new Error("接口没有返回图片");
return result.data.map((item) => {
  if (!item.b64_json) throw new Error("接口未返回图片内容，不能保证历史图片保存");
  return `data:image/png;base64,${item.b64_json}`;
});
