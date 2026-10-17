import { useEffect, useState, type SyntheticEvent } from "react";
import { createBrowserSupabase } from "../lib/browser-supabase";

interface Service { id: string; name: string }
interface MediaRecord {
  id: string;
  service_id: string;
  media_type: "image" | "video";
  storage_path: string;
  alt_text: string | null;
  caption: string | null;
  is_active: boolean;
  created_at: string;
  signedUrl?: string;
}

const client = createBrowserSupabase();

export default function AdminMediaManager() {
  const [services, setServices] = useState<Service[]>([]);
  const [media, setMedia] = useState<MediaRecord[]>([]);
  const [serviceId, setServiceId] = useState("");
  const [altText, setAltText] = useState("");
  const [caption, setCaption] = useState("");
  const [publish, setPublish] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    if (!client) return;
    const [serviceResult, mediaResult] = await Promise.all([
      client.from("services").select("id,name").order("name"),
      client.from("service_media").select("id,service_id,media_type,storage_path,alt_text,caption,is_active,created_at").order("created_at", { ascending: false }),
    ]);
    if (serviceResult.error || mediaResult.error) {
      setMessage("Media records could not be loaded. Check administrator access and try again.");
      return;
    }
    setServices(serviceResult.data ?? []);
    const records = mediaResult.data ?? [];
    const signed = await Promise.all(records.map(async (record) => {
      const { data, error } = await client.storage.from("service-media").createSignedUrl(record.storage_path, 3600);
      return { ...record, signedUrl: error ? undefined : data.signedUrl };
    }));
    setMedia(signed);
  }

  useEffect(() => { void load(); }, []);

  async function upload(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!client || !file || !serviceId) return;
    if (file.size > 50 * 1024 * 1024) {
      setMessage("Choose a file smaller than 50 MB.");
      return;
    }
    if (!["image/jpeg", "image/png", "image/webp", "image/avif", "video/mp4", "video/webm"].includes(file.type)) {
      setMessage("Choose a supported JPEG, PNG, WebP, AVIF, MP4 or WebM file.");
      return;
    }
    setBusy(true);
    setMessage("");
    const path = `${serviceId}/${crypto.randomUUID()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, "-")}`;
    const mediaType = file.type.startsWith("video/") ? "video" : "image";
    const { error: uploadError } = await client.storage.from("service-media").upload(path, file, {
      contentType: file.type,
      upsert: false,
    });
    if (uploadError) {
      setMessage(`Upload failed: ${uploadError.message}`);
      setBusy(false);
      return;
    }
    const { error: recordError } = await client.from("service_media").insert({
      service_id: serviceId,
      media_type: mediaType,
      storage_path: path,
      alt_text: altText.trim() || null,
      caption: caption.trim() || null,
      is_active: publish,
    });
    if (recordError) {
      const { error: cleanupError } = await client.storage.from("service-media").remove([path]);
      setMessage(cleanupError
        ? `Media metadata could not be saved, and the uploaded file could not be removed (${cleanupError.message}).`
        : `Media metadata could not be saved: ${recordError.message}. The uploaded file was removed.`);
      setBusy(false);
      return;
    }
    setFile(null);
    setAltText("");
    setCaption("");
    setPublish(false);
    setMessage("Media uploaded and recorded.");
    await load();
    setBusy(false);
  }

  async function setActive(record: MediaRecord) {
    if (!client) return;
    setBusy(true);
    const { error } = await client.from("service_media").update({ is_active: !record.is_active }).eq("id", record.id);
    if (error) setMessage(`Media status could not be changed: ${error.message}`);
    else {
      setMessage(record.is_active ? "Media hidden from the public service page." : "Media approved for the public service page.");
      await load();
    }
    setBusy(false);
  }

  async function remove(record: MediaRecord) {
    if (!client || !window.confirm("Permanently remove this media record and its file?")) return;
    setBusy(true);
    const { error: recordError } = await client.from("service_media").delete().eq("id", record.id);
    if (recordError) {
      setMessage(`Media record could not be removed: ${recordError.message}`);
      setBusy(false);
      return;
    }
    const { error: storageError } = await client.storage.from("service-media").remove([record.storage_path]);
    if (storageError) setMessage(`Media record was removed, but its private file remains: ${storageError.message}`);
    else setMessage("Media and private file removed.");
    await load();
    setBusy(false);
  }

  if (!client) return <div className="empty-panel"><h2>Media management is not configured.</h2><p>Connect the approved Supabase project before uploading media.</p></div>;

  return <div className="media-manager">
    <form className="admin-editor" onSubmit={upload}>
      <h2>Upload service media</h2>
      <div className="admin-editor-grid">
        <label>Service<select required value={serviceId} onChange={(event) => setServiceId(event.target.value)}><option value="">Choose a service</option>{services.map((service) => <option value={service.id} key={service.id}>{service.name}</option>)}</select></label>
        <label>Image or video<input required type="file" accept="image/jpeg,image/png,image/webp,image/avif,video/mp4,video/webm" onChange={(event) => setFile(event.target.files?.[0] ?? null)} /></label>
        <label>Alternative text<input maxLength={500} value={altText} onChange={(event) => setAltText(event.target.value)} /></label>
        <label>Caption<input maxLength={500} value={caption} onChange={(event) => setCaption(event.target.value)} /></label>
      </div>
      <label className="media-approval"><input type="checkbox" checked={publish} onChange={(event) => setPublish(event.target.checked)} /> Approve for display on the public treatment page</label>
      <p className="setup-hint">Private storage accepts approved image/video formats up to 50 MB. Unapproved media remains private and is not shown to visitors.</p>
      <button className="button" type="submit" disabled={busy || !file || !serviceId}>{busy ? "Saving…" : "Upload media"}</button>
      <p className="admin-form-message" role="status">{message}</p>
    </form>
    {media.length ? <div className="media-grid">{media.map((record) => <article className="media-card" key={record.id}>
      {record.signedUrl ? record.media_type === "image"
        ? <img src={record.signedUrl} alt={record.alt_text ?? ""} loading="lazy" />
        : <video src={record.signedUrl} controls preload="metadata" aria-label={record.alt_text ?? "Service video"} />
        : <div className="media-preview-empty">Private preview unavailable</div>}
      <div><span className={`status-badge ${record.is_active ? "status-active" : ""}`}>{record.is_active ? "Publicly approved" : "Private"}</span><p>{record.caption || record.alt_text || "No caption"}</p><div className="media-actions"><button type="button" className="admin-toggle" disabled={busy} onClick={() => void setActive(record)}>{record.is_active ? "Hide" : "Approve"}</button><button type="button" className="admin-toggle" disabled={busy} onClick={() => void remove(record)}>Remove</button></div></div>
    </article>)}</div> : <div className="empty-panel"><h2>No service media yet.</h2><p>Upload owner-approved images or videos to a service.</p></div>}
  </div>;
}
