// 받아쓰기 웹앱(dictweb1) 전용 세션 패키지 수신 함수.
// 기존 프로젝트(phD) 안에서 로봇 앱과 완전 분리: 전용 토큰(DICTWEB_UPLOAD_TOKEN),
// 전용 버킷(dictweb-session-packages), 전용 dictweb_* 테이블만 사용한다.
// 로봇 앱의 classroom-upload 함수·research_* 테이블·버킷은 일절 건드리지 않는다.
import { createClient } from "npm:@supabase/supabase-js@2";
import JSZip from "npm:jszip@3.10.1";

type SupabaseClient = ReturnType<typeof createClient>;

const BUCKET = Deno.env.get("DICTWEB_PACKAGE_BUCKET") ?? "dictweb-session-packages";

// 웹앱은 브라우저 fetch로 호출 — 커스텀 헤더 때문에 preflight(OPTIONS)가 발생한다.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-classroom-upload-token, x-session-package-name",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: CORS_HEADERS });
  }

  const expectedToken = Deno.env.get("DICTWEB_UPLOAD_TOKEN");
  const token = req.headers.get("x-classroom-upload-token");
  if (!expectedToken || token !== expectedToken) {
    return new Response("Unauthorized", { status: 401, headers: CORS_HEADERS });
  }

  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.byteLength === 0) {
    return new Response("Empty package", { status: 400, headers: CORS_HEADERS });
  }

  const packageName =
    req.headers.get("x-session-package-name") ?? `session_${crypto.randomUUID()}.zip`;
  const safeName = packageName.replace(/[^a-zA-Z0-9._-]/g, "_");

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const zip = await JSZip.loadAsync(bytes);
  const manifest = await readJson(zip, "manifest.json");
  const exportJson = await readJson(zip, "export.json");
  const eventsJsonl = await readText(zip, "events.jsonl");

  const session = first(exportJson?.studySessions);
  const sessionId: string | null = session?.session_id ?? manifest?.session?.sessionId ?? null;
  // 세션 패키지는 누적본이므로 세션당 latest.zip 하나에 덮어써도 손실이 없다(배포1 교훈).
  const storagePath = sessionId
    ? `raw/${sessionId.replace(/[^a-zA-Z0-9._-]/g, "_")}/latest.zip`
    : `raw/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}_${safeName}`;

  const packageUpload = await supabase.storage.from(BUCKET).upload(storagePath, bytes, {
    contentType: "application/zip",
    upsert: true,
  });
  if (packageUpload.error) {
    return new Response(packageUpload.error.message, { status: 500, headers: CORS_HEADERS });
  }

  const imageUploads = await uploadImages(supabase, zip, sessionId ?? "unknown_session");

  const participant = first(exportJson?.participants);
  const uploadRow = {
    storage_path: storagePath,
    storage_bucket: BUCKET,
    package_name: safeName,
    package_size_bytes: bytes.byteLength,
    status: "received",
    manifest_json: manifest ?? null,
    session_id: sessionId,
    participant_id: participant?.participant_id ?? null,
    class_id: participant?.class_id ?? null,
    supabase_response_json: { imageUploads },
  };
  const uploadInsert = await supabase
    .from("dictweb_uploads")
    .upsert(uploadRow, { onConflict: "storage_path" });
  if (uploadInsert.error) {
    return new Response(uploadInsert.error.message, { status: 500, headers: CORS_HEADERS });
  }

  await upsertTable(supabase, "dictweb_participants", exportJson?.participants, (r) => ({
    participant_id: r.participant_id,
    class_id: r.class_id,
    student_number_hash: r.student_number_hash ?? null,
    raw_json: r,
  }));

  await upsertTable(supabase, "dictweb_sessions", exportJson?.studySessions, (r) => ({
    session_id: r.session_id,
    participant_id: r.participant_id,
    class_id: r.class_id,
    class_group: textOrNull(r.class_group),
    template_id: textOrNull(r.template_id),
    judge_mode: textOrNull(r.judge_mode),
    gate_pass_threshold: numberOrNull(r.gate_pass_threshold),
    verify_tau1: numberOrNull(r.verify_tau1),
    verify_tau2: numberOrNull(r.verify_tau2),
    verify_lambda: numberOrNull(r.verify_lambda),
    started_at: numberOrNull(r.started_at),
    ended_at: numberOrNull(r.ended_at),
    session_status: textOrNull(r.session_status),
    app_version: textOrNull(r.app_version),
    device_model: textOrNull(r.device_model),
    raw_json: r,
  }));

  await upsertTable(supabase, "dictweb_attempts", exportJson?.dictationAttempts, (r) => ({
    note_attempt_id: r.note_attempt_id,
    session_id: r.session_id,
    participant_id: r.participant_id,
    class_group: textOrNull(r.class_group),
    template_id: textOrNull(r.template_id),
    word_id: textOrNull(r.word_id),
    target_word: textOrNull(r.target_word),
    slot_index: numberOrNull(r.slot_index),
    retry_index: numberOrNull(r.retry_index),
    judge_mode: textOrNull(r.judge_mode),
    judge_status: textOrNull(r.judge_status),
    is_blank: booleanOrNull(r.is_blank),
    blank_score: numberOrNull(r.blank_score),
    ink_ratio: numberOrNull(r.ink_ratio),
    gate_grade: numberOrNull(r.gate_grade),
    gate_score: numberOrNull(r.gate_score),
    gate_decision: textOrNull(r.gate_decision),
    gate_pass_threshold: numberOrNull(r.gate_pass_threshold),
    gate_model_version: textOrNull(r.gate_model_version),
    verify_margin: numberOrNull(r.verify_margin),
    verify_free_conf: numberOrNull(r.verify_free_conf),
    verify_completeness: numberOrNull(r.verify_completeness),
    verify_best_margin: numberOrNull(r.verify_best_margin),
    verify_decision: textOrNull(r.verify_decision),
    verify_tau1: numberOrNull(r.verify_tau1),
    verify_tau2: numberOrNull(r.verify_tau2),
    verify_lambda: numberOrNull(r.verify_lambda),
    ocr_raw_text: textOrNull(r.ocr_raw_text),
    spelling_correct: booleanOrNull(r.spelling_correct),
    jamo_edit_distance: numberOrNull(r.jamo_edit_distance),
    wrong_jamo_positions: parseJsonValue(r.wrong_jamo_positions),
    estimated_written: textOrNull(r.estimated_written),
    reward_level: numberOrNull(r.reward_level),
    escape_used: booleanOrNull(r.escape_used),
    feedback_message: textOrNull(r.feedback_message),
    crop_asset_id: textOrNull(r.crop_asset_id),
    crop_sha256: textOrNull(r.crop_sha256),
    scan_duration_ms: numberOrNull(r.scan_duration_ms),
    gate_duration_ms: numberOrNull(r.gate_duration_ms),
    ocr_duration_ms: numberOrNull(r.ocr_duration_ms),
    created_at: numberOrNull(r.created_at),
    raw_json: r,
  }));

  await upsertTable(supabase, "dictweb_file_assets", exportJson?.fileAssets, (r, index) => {
    const entryBase = `images/${r.asset_type}_${index + 1}`;
    const uploaded =
      imageUploads.find(
        (u) => u.packagePath === entryBase || u.packagePath.startsWith(`${entryBase}.`),
      ) ?? null;
    return {
      file_asset_id: r.file_asset_id,
      session_id: r.session_id,
      note_attempt_id: r.note_attempt_id,
      asset_type: r.asset_type,
      storage_bucket: uploaded ? BUCKET : null,
      storage_path: uploaded?.storagePath ?? null,
      mime_type: r.mime_type,
      file_size_bytes: r.file_size_bytes ?? uploaded?.sizeBytes ?? null,
      sha256: r.sha256,
      width: r.width,
      height: r.height,
      slot_index: r.slot_index,
      raw_json: { ...r, uploaded_image: uploaded },
    };
  });

  await upsertEvents(supabase, exportJson?.eventLogs, eventsJsonl);

  return Response.json(
    { ok: true, bucket: BUCKET, storagePath, sizeBytes: bytes.byteLength, imageUploads: imageUploads.length },
    { headers: CORS_HEADERS },
  );
});

async function readText(zip: JSZip, path: string): Promise<string | null> {
  const file = zip.file(path);
  return file ? await file.async("text") : null;
}

async function readJson(zip: JSZip, path: string): Promise<any | null> {
  const text = await readText(zip, path);
  if (!text || !text.trim()) return null;
  return JSON.parse(text);
}

function first(value: unknown): any | null {
  return Array.isArray(value) && value.length > 0 ? value[0] : null;
}

async function uploadImages(supabase: SupabaseClient, zip: JSZip, sessionId: string) {
  const uploaded: Array<{ packagePath: string; storagePath: string; sizeBytes: number }> = [];
  for (const [path, file] of Object.entries(zip.files)) {
    if (!path.startsWith("images/") || file.dir) continue;
    const imageBytes = await file.async("uint8array");
    // 내용 주소화(sha256): 같은 크롭 재전송 시 같은 경로에 덮어써 사본이 늘지 않는다.
    const digest = await crypto.subtle.digest("SHA-256", imageBytes);
    const sha = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase() || "bin";
    const storagePath = `images/${sessionId}/${sha}.${ext}`;
    const result = await supabase.storage.from(BUCKET).upload(storagePath, imageBytes, {
      contentType: path.toLowerCase().endsWith(".png") ? "image/png" : "application/octet-stream",
      upsert: true,
    });
    if (result.error) throw new Error(result.error.message);
    uploaded.push({ packagePath: path, storagePath, sizeBytes: imageBytes.byteLength });
  }
  return uploaded;
}

async function upsertEvents(supabase: SupabaseClient, eventRows: any, eventsJsonl: string | null) {
  const events: any[] = Array.isArray(eventRows) ? [...eventRows] : [];
  if (eventsJsonl) {
    for (const line of eventsJsonl.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      events.push(JSON.parse(trimmed));
    }
  }
  const rowsById = new Map<string, any>();
  for (const event of events) {
    const id = event.event_id;
    if (!id) continue;
    rowsById.set(id, {
      event_id: id,
      session_id: event.session_id ?? null,
      participant_id: event.participant_id ?? null,
      note_attempt_id: event.note_attempt_id ?? null,
      event_type: event.event_type,
      event_time: numberOrNull(event.event_time),
      local_sequence: numberOrNull(event.local_sequence),
      severity: textOrNull(event.severity),
      source: textOrNull(event.source),
      message: textOrNull(event.message),
      payload_json: parseJsonValue(event.payload_json),
      raw_json: event,
    });
  }
  await upsertTable(supabase, "dictweb_events", [...rowsById.values()], (r) => r);
}

function parseJsonValue(value: unknown) {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return { value };
    }
  }
  return value ?? null;
}

function textOrNull(value: unknown) {
  if (value == null) return null;
  const text = String(value);
  return text.length > 0 ? text : null;
}

function numberOrNull(value: unknown) {
  if (value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function booleanOrNull(value: unknown) {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

async function upsertTable(
  supabase: SupabaseClient,
  tableName: string,
  rows: any,
  mapper: (row: any, index: number) => Record<string, unknown>,
) {
  if (!Array.isArray(rows) || rows.length === 0) return;
  const mapped = rows.map(mapper);
  const result = await supabase.from(tableName).upsert(mapped);
  if (result.error) throw new Error(`${tableName}: ${result.error.message}`);
}
