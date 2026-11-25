interface PrivacyViewProps {
  maxPhotos: number;
  onBackToGallery: () => void;
}

export function PrivacyView({ maxPhotos, onBackToGallery }: PrivacyViewProps) {
  return (
    <main className="mx-auto w-full max-w-3xl px-4 pb-20 pt-10 sm:px-6 lg:pt-14">
      <div className="border-b border-zinc-200 pb-8">
        <h1 className="text-3xl font-semibold tracking-tight text-[#111111]">
          Datenschutz beim Tag der offenen Tür
        </h1>
        <p className="mt-2.5 text-[15px] leading-relaxed text-zinc-600">
          Diese Live-Galerie wurde gezielt nach dem Prinzip der Datensparsamkeit für
          Schul- und Hochschulveranstaltungen gestaltet.
        </p>
      </div>

      <div className="mt-8 space-y-8">
        <section>
          <h2 className="text-base font-semibold text-[#111111]">
            01. Automatische Löschung nach exakt 5 Minuten
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-zinc-600">
            Jede hochgeladene Aufnahme besitzt eine feste Lebensdauer von genau 300 Sekunden.
            Nach Ablauf dieser Frist wird das Foto serverseitig vollständig gelöscht und
            verschwindet gleichzeitig aus der Galerie und vom Beamer-Kiosk.
          </p>
        </section>

        <section className="border-t border-zinc-200/80 pt-8">
          <h2 className="text-base font-semibold text-[#111111]">
            02. Begrenzung auf maximal {maxPhotos} aktive Fotos
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-zinc-600">
            Es werden zu keinem Zeitpunkt mehr als {maxPhotos} Fotos gleichzeitig vorgehalten.
            Wird bei großem Andrang ein neues Bild hochgeladen, ersetzt es automatisch die
            älteste Aufnahme und löscht diese sofort aus dem Speicher.
          </p>
        </section>

        <section className="border-t border-zinc-200/80 pt-8">
          <h2 className="text-base font-semibold text-[#111111]">
            03. Sofortige Entfernung auf Wunsch & kein Tracking
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-zinc-600">
            Besucherinnen und Besucher benötigen kein Benutzerkonto. Es werden keine
            Werbe-Cookies oder Analysedienste geladen, und alle Bilddateien werden mit
            <span className="mx-1 font-mono text-xs text-[#111111]">Cache-Control: no-store</span>
            ausgeliefert. Möchte jemand eine Aufnahme nicht zeigen, kann das Fototeam sie
            innerhalb von Sekunden vorzeitig löschen.
          </p>
        </section>

        <section className="border-t border-zinc-200/80 pt-8">
          <h2 className="text-base font-semibold text-[#111111]">
            04. Direkt in Apple Fotos & Android-Galerie sichern
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-zinc-600">
            Auf iPhones und iPads öffnet „In Fotos sichern“ das native Teilen-Menü mit der
            Originaldatei — über „Bild sichern“ landet das Bild verlustfrei direkt in Apple
            Fotos. Auf Android-Geräten speichert der Download oder das Teilen-Menü das Bild
            ebenfalls in voller Originalauflösung direkt in der Fotomediathek.
          </p>
        </section>
      </div>

      <div className="mt-10 border-t border-zinc-200 pt-6">
        <button
          type="button"
          onClick={onBackToGallery}
          className="min-h-[44px] whitespace-nowrap rounded-lg bg-[#111111] px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#2563EB]"
        >
          Zurück zur Live-Galerie
        </button>
      </div>
    </main>
  );
}
