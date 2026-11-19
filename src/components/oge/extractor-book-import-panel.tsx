import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { inspectFile, sourceSha, unitSchema } from "@/lib/extractor/schema";
import { importBookBatch } from "@/lib/admin-book-import.functions";
import { getExtractorJobs } from "@/lib/extractor/jobs.functions";

type Props = { book: unknown; filename: string; canWrite: boolean; onReset: () => void };

export function ExtractorBookImportPanel({ book, filename, canWrite, onReset }: Props) {
  const checked = inspectFile(book);
  const hashes = new Set(checked.units.flatMap(unit => {
    const parsed = unitSchema.safeParse(unit);
    return parsed.success ? [sourceSha(parsed.data)] : [];
  }));
  const sourceHash = hashes.size === 1 ? [...hashes][0] : null;
  const list = useServerFn(getExtractorJobs);
  const save = useServerFn(importBookBatch);
  const jobs = useQuery({ queryKey: ["audit-source-jobs"], enabled: canWrite, queryFn: () => list() });
  const [jobId, setJobId] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  const candidates = (jobs.data?.jobs ?? []).filter(j => j.file_sha256 === sourceHash);
  const invalid = checked.errors.length > 0 || checked.reports.some(r => r.status === "failed") || !sourceHash;
  async function submit() {
    if (!canWrite || !confirmed || !jobId || invalid || busy) return;
    setBusy(true); setError("");
    try {
      const { units: _units, ...envelope_metadata } = book as Record<string, unknown>;
      await save({ data: { confirmed: true, job_id: jobId, units: checked.units, envelope_metadata } });
      setDone(true);
    } catch (e) { setError(e instanceof Error ? e.message : "Не удалось сохранить результат"); }
    finally { setBusy(false); }
  }
  return <div className="border rounded-lg p-4 space-y-3">
    <h3 className="font-semibold">Импорт результата Pathy Extractor</h3>
    <p className="text-sm">{filename}: {checked.units.length} единиц. Сначала загрузите исходный файл в раздел обработок; его SHA должен совпадать с результатом.</p>
    <p className="text-sm text-muted-foreground">Все единицы поступят в общее задание на проверку. Их публикация требует решения человека, прав и утверждённой темы.</p>
    {invalid && <p role="alert" className="text-destructive">Результат содержит ошибки, повторные ID или несколько источников. Импорт целиком остановлен.</p>}
    {jobs.isError && <p role="alert" className="text-destructive">Не удалось получить задания источников.</p>}
    {!canWrite && <p role="alert">Нужна сессия администратора. <Link to="/auth">Войти</Link>.</p>}
    <label className="block text-sm">Задание исходника
      <select className="block border rounded p-2 w-full" value={jobId} onChange={e => setJobId(e.target.value)} disabled={!canWrite || done}>
        <option value="">Выберите задание</option>
        {candidates.map(j => <option key={j.id} value={j.id}>{j.file_name} · версия {j.revision} · {j.status}</option>)}
      </select>
    </label>
    {!candidates.length && sourceHash && <p className="text-sm">Задание с этим SHA не найдено среди последних загрузок.</p>}
    <label className="block text-sm">Или ID существующего задания
      <input className="block border rounded p-2 w-full" value={jobId} onChange={e => setJobId(e.target.value)} disabled={!canWrite || done} placeholder="UUID задания" />
    </label>
    {!done && <label className="text-sm flex gap-2"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />Подтверждаю приём результата на проверку без автоматической публикации.</label>}
    <div className="flex gap-2"><Button disabled={!canWrite || !confirmed || !jobId || invalid || busy || done} onClick={() => void submit()}>{busy ? "Сохранение…" : done ? "Сохранено" : "Передать на проверку"}</Button><Button variant="outline" disabled={busy} onClick={onReset}>Другой файл</Button></div>
    {done && <p role="status">Результат сохранён в задании. Откройте обработку для ревью и публикации.</p>}
    {error && <p role="alert" className="text-destructive">{error}</p>}
  </div>;
}
