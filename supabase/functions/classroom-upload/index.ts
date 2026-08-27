import { createClient } from "npm:@supabase/supabase-js@2";
import JSZip from "npm:jszip@3.10.1";

type SupabaseClient = ReturnType<typeof createClient>;

// 웹앱(dictweb1)은 브라우저 fetch로 호출 — 커스텀 헤더 때문에 preflight(OPTIONS)가 발생한다.
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

  const expectedToken = Deno.env.get("CLASSROOM_UPLOAD_TOKEN");
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
  const bucket = Deno.env.get("SESSION_PACKAGE_BUCKET") ?? "research-session-packages";
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
  const sessionId: string | null =
    session?.session_id ?? manifest?.session?.sessionId ?? null;
  // 배포1은 매 POST마다 무작위 경로에 ZIP 전량을 새로 저장해 세션당 평균 7.5개
  // (총 8.2GB, 85% 중복)가 쌓였다. 내보내기는 세션 누적본이라 최신 ZIP이 이전
  // ZIP의 상위집합이므로, 세션당 latest.zip 하나에 덮어써도 데이터 손실이 없다.
  const storagePath = sessionId
    ? `raw/${sessionId.replace(/[^a-zA-Z0-9._-]/g, "_")}/latest.zip`
    : `raw/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}_${safeName}`;

  const packageUpload = await supabase.storage.from(bucket).upload(storagePath, bytes, {
    contentType: "application/zip",
    upsert: true,
  });
  if (packageUpload.error) {
    return new Response(packageUpload.error.message, { status: 500, headers: CORS_HEADERS });
  }

  const imageUploads = await uploadImages(supabase, bucket, zip, manifest);

  const participant = first(exportJson?.participants);
  const participantId = participant?.participant_id ?? manifest?.participant?.participantId ?? null;
  const normalizedGrade = gradeFromParticipantId(
    participantId,
    participant?.grade ?? manifest?.participant?.grade ?? null,
  );
  const uploadRow = {
    storage_bucket: bucket,
    storage_path: storagePath,
    package_name: safeName,
    package_size_bytes: bytes.byteLength,
    status: "received",
    manifest_json: manifest ?? null,
    session_id: sessionId,
    participant_id: participantId,
    school_code: participant?.school_code ?? manifest?.participant?.schoolCode ?? null,
    class_id: participant?.class_id ?? manifest?.participant?.classId ?? null,
    grade: normalizedGrade,
    group_type: participant?.group_type ?? manifest?.participant?.groupType ?? null,
    supabase_response_json: { imageUploads },
  };

  // 세션당 storage_path가 고정이므로 재전송은 insert 충돌 대신 갱신으로 처리한다.
  const uploadInsert = await supabase
    .from("session_uploads")
    .upsert(uploadRow, { onConflict: "storage_path" });
  if (uploadInsert.error) {
    return new Response(uploadInsert.error.message, { status: 500, headers: CORS_HEADERS });
  }

  await upsertResearchRows(supabase, exportJson, imageUploads);
  await upsertEvents(supabase, exportJson?.eventLogs, eventsJsonl);

  return Response.json(
    {
      ok: true,
      bucket,
      storagePath,
      sizeBytes: bytes.byteLength,
      imageUploads: imageUploads.length,
    },
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

function gradeFromParticipantId(participantId: string | null, fallback: unknown) {
  const match = participantId?.match(/_(\d+)$/);
  const firstDigit = match?.[1]?.charAt(0);
  const derived = firstDigit ? Number(firstDigit) : NaN;
  if (Number.isFinite(derived)) return derived;
  const fallbackNumber = Number(fallback);
  return Number.isFinite(fallbackNumber) ? fallbackNumber : null;
}

function withNormalizedGrade(row: any) {
  return {
    ...row,
    grade: gradeFromParticipantId(row?.participant_id ?? null, row?.grade ?? null),
  };
}

async function uploadImages(
  supabase: SupabaseClient,
  bucket: string,
  zip: JSZip,
  manifest: any | null,
) {
  const sessionId = manifest?.session?.sessionId ?? "unknown_session";
  const uploaded: Array<{ packagePath: string; storagePath: string; sizeBytes: number }> = [];

  for (const [path, file] of Object.entries(zip.files)) {
    if (!path.startsWith("images/") || file.dir) continue;
    const imageBytes = await file.async("uint8array");
    // 내용 주소화(sha256): 같은 크롭이 재전송되어도 같은 경로에 덮어써 사본이 늘지 않는다.
    const digest = await crypto.subtle.digest("SHA-256", imageBytes);
    const sha = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase() || "bin";
    const storagePath = `images/${sessionId}/${sha}.${ext}`;
    const mimeType = mimeFromPath(path);
    const result = await supabase.storage.from(bucket).upload(storagePath, imageBytes, {
      contentType: mimeType,
      upsert: true,
    });
    if (result.error) throw new Error(result.error.message);
    uploaded.push({ packagePath: path, storagePath, sizeBytes: imageBytes.byteLength });
  }

  return uploaded;
}

function mimeFromPath(path: string) {
  const lower = path.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  return "application/octet-stream";
}

async function upsertResearchRows(
  supabase: SupabaseClient,
  exportJson: any | null,
  imageUploads: Array<{ packagePath: string; storagePath: string; sizeBytes: number }>,
) {
  if (!exportJson) return;

  await upsertTable(supabase, "research_participants", exportJson.participants, (r) => {
    const row = withNormalizedGrade(r);
    return {
      participant_id: row.participant_id,
      class_id: row.class_id,
      school_code: row.school_code,
      grade: row.grade,
      group_type: row.group_type,
      raw_json: row,
    };
  });

  await upsertTable(supabase, "research_study_sessions", exportJson.studySessions, (r) => {
    const row = withNormalizedGrade(r);
    return {
      session_id: row.session_id,
      participant_id: row.participant_id,
      class_id: row.class_id,
      school_code: row.school_code,
      grade: row.grade,
      group_type: row.group_type,
      started_at: row.started_at,
      ended_at: row.ended_at,
      session_status: row.session_status,
      upload_status: row.upload_status,
      device_model: row.device_model ?? null,
      android_version: row.android_version ?? null,
      screen_width: numberOrNull(row.screen_width),
      screen_height: numberOrNull(row.screen_height),
      raw_json: row,
    };
  });

  await upsertTable(supabase, "research_problem_attempts", exportJson.problemAttempts, (r) => ({
    problem_attempt_id: r.problem_attempt_id,
    session_id: r.session_id,
    participant_id: r.participant_id,
    problem_id: r.problem_id,
    template_id: r.template_id,
    concept: r.concept,
    attempt_status: r.attempt_status,
    raw_json: r,
  }));

  await upsertTable(supabase, "research_program_revisions", exportJson.programRevisions, (r) => ({
    revision_id: r.revision_id,
    problem_attempt_id: r.problem_attempt_id,
    session_id: r.session_id,
    participant_id: r.participant_id,
    revision_index: r.revision_index,
    status: r.status,
    failure_stage: r.failure_stage,
    failure_code: r.failure_code,
    blank_count: r.blank_count,
    non_blank_count: r.non_blank_count,
    raw_json: r,
  }));

  await upsertTable(supabase, "research_note_attempts", exportJson.noteAttempts, (r) => ({
    note_attempt_id: r.note_attempt_id,
    revision_id: r.revision_id,
    problem_attempt_id: r.problem_attempt_id,
    session_id: r.session_id,
    participant_id: r.participant_id,
    slot_index: r.slot_index,
    slot_id: r.slot_id,
    is_blank: r.is_blank,
    skipped_before_ocr: r.skipped_before_ocr,
    blank_score: r.blank_score,
    ink_ratio: r.ink_ratio,
    crop_sha256: r.crop_sha256,
    ocr_raw_text: r.ocr_raw_text,
    ocr_normalized_text: r.ocr_normalized_text,
    ocr_corrected_text: r.ocr_corrected_text,
    ocr_confidence: r.ocr_confidence,
    ocr_command_score: r.ocr_command_score,
    ocr_decision: r.ocr_decision,
    ocr_candidates_json: parseJsonValue(r.ocr_candidates_json),
    llm_input_text: r.llm_input_text,
    llm_output_json: parseJsonValue(r.llm_output_json),
    llm_success: r.llm_success,
    llm_needs_rewrite: r.llm_needs_rewrite,
    llm_semantic_confidence: r.llm_semantic_confidence,
    llm_failure_code: r.llm_failure_code,
    slot_dsl_json: parseJsonValue(r.slot_dsl_json),
    crop_asset_id: r.crop_asset_id,
    gate_score: numberOrNull(r.gate_score),
    gate_grade: numberOrNull(r.gate_grade),
    gate_decision: textOrNull(r.gate_decision),
    gate_threshold: numberOrNull(r.gate_threshold),
    gate_model_version: textOrNull(r.gate_model_version),
    llm_prompt_version: textOrNull(r.llm_prompt_version),
    raw_json: r,
  }));

  // ── 받아쓰기 웹앱(dictweb1) 시도 — 검증 지표(conf/C/M) 포함 정형 적재 ──
  await upsertTable(supabase, "research_dictation_attempts", exportJson.dictationAttempts, (r) => ({
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

  await upsertTable(supabase, "research_program_validations", exportJson.programValidations, (r) => ({
    validation_id: r.validation_id,
    revision_id: r.revision_id,
    problem_attempt_id: r.problem_attempt_id,
    session_id: r.session_id,
    participant_id: r.participant_id,
    is_valid: r.is_valid,
    is_executable: r.is_executable,
    command_count: r.command_count,
    expanded_command_count: r.expanded_command_count,
    raw_json: r,
  }));

  await upsertTable(supabase, "research_program_executions", exportJson.programExecutions, (r) => ({
    execution_id: r.execution_id,
    revision_id: r.revision_id,
    validation_id: r.validation_id,
    problem_attempt_id: r.problem_attempt_id,
    session_id: r.session_id,
    participant_id: r.participant_id,
    execution_status: r.execution_status,
    goal_reached: r.goal_reached,
    collision: r.collision,
    failure_code: r.failure_code,
    executed_command_count: r.executed_command_count,
    actual_path_length: r.actual_path_length,
    raw_json: r,
  }));

  await upsertTable(supabase, "research_file_assets", exportJson.fileAssets, (r, index) => {
    // Match the uploaded image by its zip entry name, not by array position.
    // Assets without an on-disk image file are skipped while zipping (exporter:
    // "images/${assetType}_${index+1}.ext"), so imageUploads is shorter/shifted
    // relative to fileAssets and positional indexing mis-attributes storage paths.
    const entryBase = `images/${r.asset_type}_${index + 1}`;
    const uploaded = imageUploads.find(
      (u) => u.packagePath === entryBase || u.packagePath.startsWith(`${entryBase}.`),
    ) ?? null;
    return {
      file_asset_id: r.file_asset_id,
      session_id: r.session_id,
      problem_attempt_id: r.problem_attempt_id,
      revision_id: r.revision_id,
      note_attempt_id: r.note_attempt_id,
      asset_type: r.asset_type,
      storage_bucket: uploaded ? Deno.env.get("SESSION_PACKAGE_BUCKET") ?? "research-session-packages" : r.storage_bucket,
      storage_path: uploaded?.storagePath ?? r.storage_path,
      local_path: r.local_path,
      mime_type: r.mime_type,
      file_size_bytes: r.file_size_bytes ?? uploaded?.sizeBytes ?? null,
      sha256: r.sha256,
      width: r.width,
      height: r.height,
      slot_index: r.slot_index,
      raw_json: { ...r, uploaded_image: uploaded },
    };
  });
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
    const id = event.event_id ?? event.eventId;
    if (!id) continue;
    const eventTime = event.event_time ?? event.eventTime ?? null;
    const eventTimeEpoch =
      typeof eventTime === "number" ? eventTime :
      Number.isFinite(Number(event.event_time_epoch_ms ?? event.eventTimeEpochMs))
        ? Number(event.event_time_epoch_ms ?? event.eventTimeEpochMs)
        : null;
    rowsById.set(id, {
      event_id: id,
      session_id: event.session_id ?? event.sessionId ?? null,
      participant_id: event.participant_id ?? event.participantId ?? null,
      problem_attempt_id: event.problem_attempt_id ?? event.problemAttemptId ?? null,
      revision_id: event.revision_id ?? event.revisionId ?? null,
      note_attempt_id: event.note_attempt_id ?? event.noteAttemptId ?? null,
      execution_id: event.execution_id ?? event.executionId ?? null,
      event_type: event.event_type ?? event.eventType,
      event_time: eventTimeEpoch,
      event_time_text: event.event_time_text ?? event.eventTimeText ?? formatKstDateTime(eventTimeEpoch),
      local_sequence: event.local_sequence ?? event.localSequence ?? null,
      severity: event.severity ?? null,
      source: event.source ?? null,
      message: event.message ?? null,
      payload_json: parsePayload(event.payload_json ?? event.payload),
      raw_json: event,
    });
  }

  await upsertTable(supabase, "research_event_logs", [...rowsById.values()], (r) => r);
  await upsertWorksheetScanFailures(supabase, [...rowsById.values()]);
}

async function upsertWorksheetScanFailures(supabase: SupabaseClient, eventRows: any[]) {
  const failureRows = eventRows
    .filter((event) =>
      event.event_type === "worksheet_scan.failed" || event.event_type === "problem.load_failed"
    )
    .map((event) => {
      const payload = parsePayload(event.payload_json ?? event.payload ?? {});
      return {
        failure_id: event.event_id,
        event_id: event.event_id,
        session_id: event.session_id ?? null,
        participant_id: event.participant_id ?? null,
        event_time: event.event_time ?? null,
        event_time_text: event.event_time_text ?? null,
        failure_stage: textOrNull(payload.failureStage ?? payload.failure_stage),
        failure_code: textOrNull(payload.failureCode ?? payload.failure_code),
        recognition_reason: textOrNull(payload.recognitionReason ?? payload.recognition_reason),
        student_message_code: textOrNull(payload.studentMessageCode ?? payload.student_message_code),
        selected_template_id: textOrNull(payload.selectedTemplateId ?? payload.selected_template_id),
        ocr_template_id: textOrNull(payload.ocrTemplateId ?? payload.ocr_template_id),
        marker_template_id: textOrNull(payload.markerTemplateId ?? payload.marker_template_id),
        problem_marker_template_id: textOrNull(
          payload.problemMarkerTemplateId ?? payload.problem_marker_template_id,
        ),
        problem_marker_id: textOrNull(payload.problemMarkerId ?? payload.problem_marker_id),
        problem_marker_count: numberOrNull(payload.problemMarkerCount ?? payload.problem_marker_count),
        marker_distance: numberOrNull(payload.markerDistance ?? payload.marker_distance),
        marker_runner_up: numberOrNull(payload.markerRunnerUp ?? payload.marker_runner_up),
        marker_confident: booleanOrNull(payload.markerConfident ?? payload.marker_confident),
        capture_rotation_deg: numberOrNull(payload.captureRotationDeg ?? payload.capture_rotation_deg),
        rotation_postprocess_enabled: booleanOrNull(
          payload.rotationPostprocessEnabled ?? payload.rotation_postprocess_enabled,
        ),
        device_model: textOrNull(payload.deviceModel ?? payload.device_model),
        android_version: textOrNull(payload.osVersion ?? payload.os_version ?? payload.android_version),
        payload_json: payload,
        raw_json: event.raw_json ?? event,
      };
    });

  await upsertTable(supabase, "research_worksheet_scan_failures", failureRows, (r) => r);
}

function formatKstDateTime(epochMs: number | null) {
  if (epochMs == null) return null;
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(epochMs));
  return parts.replace("T", " ");
}

function parsePayload(payload: unknown) {
  if (typeof payload === "string") {
    try {
      return JSON.parse(payload);
    } catch {
      return { value: payload };
    }
  }
  return payload ?? {};
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
