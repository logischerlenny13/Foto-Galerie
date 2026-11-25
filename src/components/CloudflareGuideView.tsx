import { useState } from 'react';
import { Check, Copy } from 'lucide-react';

interface CloudflareGuideViewProps {
  embedded?: boolean;
}

const D1_SQL_SNIPPET = `CREATE TABLE IF NOT EXISTS photos (
  id TEXT PRIMARY KEY,
  r2_key TEXT NOT NULL,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_photos_created ON photos(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_photos_expires ON photos(expires_at ASC);

CREATE TABLE IF NOT EXISTS app_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);`;

export function CloudflareGuideView({ embedded = false }: CloudflareGuideViewProps) {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const copyText = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      window.setTimeout(() => setCopiedKey(null), 2000);
    } catch {
      // Clipboard may be blocked in restricted contexts
    }
  };

  const content = (
    <>
      <div className="border-b border-zinc-200 pb-6">
        <h2 className="text-xl font-semibold tracking-tight text-[#111111]">
          Cloudflare Pages, R2 Storage &amp; D1 einrichten
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-zinc-600">
          Dieses Projekt enthält bereits die fertige Cloudflare-Pages-API mit automatischer
          5-Minuten-Löschung und 30-Foto-Rollover-Limit für R2 (Dateispeicher) und D1 (Datenbank)
          im kostenlosen Free Tier.
        </p>
      </div>

      <ol className="mt-6 space-y-6">
        <li className="space-y-2">
          <h3 className="text-sm font-semibold text-[#111111]">
            01. Projekt auf GitHub hochladen &amp; mit Cloudflare Pages verbinden
          </h3>
          <p className="text-sm leading-relaxed text-zinc-600">
            Lade das gesamte Projekt in ein GitHub-Repository hoch. Öffne im Cloudflare Dashboard{' '}
            <span className="font-medium text-[#111111]">
              Workers &amp; Pages → Create → Pages → Connect to Git
            </span>{' '}
            und wähle folgende Build-Einstellungen:
          </p>
          <div className="rounded-xl border border-zinc-200 bg-white px-4 py-3 font-mono text-xs text-zinc-800">
            <div>Build command: npm run build</div>
            <div className="mt-1">Build output directory: dist</div>
          </div>
        </li>

        <li className="space-y-2 border-t border-zinc-200/80 pt-6">
          <h3 className="text-sm font-semibold text-[#111111]">
            02. Cloudflare R2 Bucket (Foto-Storage) erstellen
          </h3>
          <p className="text-sm leading-relaxed text-zinc-600">
            Gehe im Cloudflare Dashboard auf{' '}
            <span className="font-medium text-[#111111]">R2 Object Storage → Create bucket</span>,
            nenne ihn z. B.{' '}
            <span className="font-mono text-xs text-[#111111]">tag-der-offenen-tuer-fotos</span>{' '}
            (Region: Western Europe / EEUR) und erstelle ihn. Im Free Tier sind 10 GB Speicher
            und kostenloser Egress enthalten.
          </p>
        </li>

        <li className="space-y-2 border-t border-zinc-200/80 pt-6">
          <h3 className="text-sm font-semibold text-[#111111]">
            03. Cloudflare D1 Datenbank erstellen &amp; Tabellen anlegen
          </h3>
          <p className="text-sm leading-relaxed text-zinc-600">
            Gehe zu{' '}
            <span className="font-medium text-[#111111]">
              Storage &amp; Databases → D1 SQL Database → Create
            </span>{' '}
            (Name z. B.{' '}
            <span className="font-mono text-xs text-[#111111]">tag-der-offenen-tuer-db</span>).
            Öffne dort den Tab <span className="font-medium text-[#111111]">Console</span> und führe
            einmalig dieses SQL aus:
          </p>

          <div className="relative overflow-hidden rounded-xl border border-zinc-200 bg-[#111113] text-zinc-100">
            <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-2 text-xs text-zinc-400">
              <span className="font-mono">cloudflare/schema.sql</span>
              <button
                type="button"
                onClick={() => void copyText('sql', D1_SQL_SNIPPET)}
                className="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium text-zinc-200 transition-colors hover:bg-zinc-800"
              >
                {copiedKey === 'sql' ? (
                  <>
                    <Check className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Kopiert</span>
                  </>
                ) : (
                  <>
                    <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>SQL kopieren</span>
                  </>
                )}
              </button>
            </div>
            <pre className="overflow-x-auto p-4 font-mono text-xs leading-relaxed">
              <code>{D1_SQL_SNIPPET}</code>
            </pre>
          </div>
        </li>

        <li className="space-y-2 border-t border-zinc-200/80 pt-6">
          <h3 className="text-sm font-semibold text-[#111111]">
            04. R2, D1 und Team-PIN in Cloudflare Pages verknüpfen
          </h3>
          <p className="text-sm leading-relaxed text-zinc-600">
            Öffne dein Pages-Projekt →{' '}
            <span className="font-medium text-[#111111]">Settings → Bindings</span> und füge zwei
            Bindings exakt mit diesen Variablennamen hinzu:
          </p>
          <div className="space-y-1.5 rounded-xl border border-zinc-200 bg-white px-4 py-3 font-mono text-xs text-zinc-800">
            <div>1. R2 bucket binding · Variable name: PHOTOS_BUCKET → dein R2 Bucket</div>
            <div>2. D1 database binding · Variable name: DB → deine D1 Datenbank</div>
          </div>
          <p className="pt-2 text-sm leading-relaxed text-zinc-600">
            Setze anschließend unter{' '}
            <span className="font-medium text-[#111111]">Settings → Variables and Secrets</span>{' '}
            ein Secret namens <span className="font-mono text-xs text-[#111111]">UPLOAD_PIN</span>{' '}
            und starte ein neues Deployment.
          </p>
        </li>
      </ol>
    </>
  );

  if (embedded) {
    return (
      <section className="rounded-2xl border border-zinc-200 bg-white p-6 sm:p-8">
        {content}
      </section>
    );
  }

  return <main className="mx-auto w-full max-w-3xl px-4 pb-20 pt-10 sm:px-6 lg:pt-14">{content}</main>;
}
