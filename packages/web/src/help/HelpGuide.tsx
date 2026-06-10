import { useEffect, useMemo, useState } from 'react';
import { HELP_TOPICS, type HelpImage, type HelpTopic } from './helpContent';

type HelpGuideProps = {
  initialTopicId?: string;
  onClose: () => void;
};

export default function HelpGuide(props: HelpGuideProps) {
  const [activeTopicId, setActiveTopicId] = useState(props.initialTopicId ?? HELP_TOPICS[0].id);
  const [query, setQuery] = useState('');
  const [lightboxImage, setLightboxImage] = useState<HelpImage | null>(null);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }
      event.stopPropagation();
      if (lightboxImage != null) {
        setLightboxImage(null);
      } else {
        props.onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [lightboxImage, props]);

  const visibleTopics = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) {
      return HELP_TOPICS;
    }

    return HELP_TOPICS.filter((topic) => {
      const haystack = [
        topic.title,
        topic.kicker,
        topic.summary,
        topic.intro,
        ...topic.keywords,
        ...(topic.steps ?? []).map((step) => `${step.title} ${step.body}`),
      ].join(' ').toLowerCase();
      return normalized.split(/\s+/).every((term) => haystack.includes(term));
    });
  }, [query]);

  const activeTopic =
    visibleTopics.find((topic) => topic.id === activeTopicId)
    ?? visibleTopics[0]
    ?? null;

  return (
    <div className="modal-overlay help-overlay" onClick={props.onClose}>
      <div className="glass-panel modal-shell help-shell" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <h2>Help & user guide</h2>
          <button className="modal-close" onClick={props.onClose}>
            x
          </button>
        </div>

        <div className="help-layout">
          <aside className="help-sidebar">
            <input
              autoFocus
              className="glass-input help-search"
              placeholder="Search the guide..."
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <nav className="help-topic-list">
              {visibleTopics.map((topic) => (
                <button
                  key={topic.id}
                  className={`help-topic-item ${topic.id === activeTopic?.id ? 'active' : ''}`}
                  onClick={() => setActiveTopicId(topic.id)}
                >
                  <span className="help-topic-kicker">{topic.kicker}</span>
                  <span className="help-topic-title">{topic.title}</span>
                  <span className="help-topic-summary">{topic.summary}</span>
                </button>
              ))}
              {visibleTopics.length === 0 && (
                <div className="help-empty">No topics match “{query.trim()}”.</div>
              )}
            </nav>
          </aside>

          <article className="help-content">
            {activeTopic != null && (
              <TopicView topic={activeTopic} onZoom={setLightboxImage} />
            )}
          </article>
        </div>
      </div>

      {lightboxImage != null && (
        <div className="help-lightbox" onClick={(event) => { event.stopPropagation(); setLightboxImage(null); }}>
          <figure>
            <img alt={lightboxImage.caption} src={lightboxImage.src} />
            <figcaption>{lightboxImage.caption}</figcaption>
          </figure>
        </div>
      )}
    </div>
  );
}

function TopicView(props: { topic: HelpTopic; onZoom: (image: HelpImage) => void }) {
  const { topic } = props;

  return (
    <div className="help-topic-view">
      <div className="section-kicker">{topic.kicker}</div>
      <h3 className="help-topic-heading">{topic.title}</h3>
      <p className="help-topic-intro">{topic.intro}</p>

      {topic.heroImage != null && (
        <HelpFigure image={topic.heroImage} onZoom={props.onZoom} />
      )}

      {(topic.steps ?? []).map((step, index) => (
        <section className="help-step" key={`${topic.id}-step-${index}`}>
          <div className="help-step-head">
            <span className="help-step-number">{index + 1}</span>
            <span className="help-step-title">{step.title}</span>
            {step.shortcut != null && <kbd className="kbd">{step.shortcut}</kbd>}
          </div>
          <p className="help-step-body">{step.body}</p>
          {step.image != null && <HelpFigure image={step.image} onZoom={props.onZoom} />}
        </section>
      ))}

      {topic.shortcuts != null && (
        <table className="help-shortcut-table">
          <tbody>
            {topic.shortcuts.map((shortcut) => (
              <tr key={shortcut.keys}>
                <td><kbd className="kbd">{shortcut.keys}</kbd></td>
                <td>{shortcut.action}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {topic.tips != null && topic.tips.length > 0 && (
        <div className="help-tips">
          <div className="help-tips-title">Good to know</div>
          <ul>
            {topic.tips.map((tip, index) => (
              <li key={`${topic.id}-tip-${index}`}>{tip}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function HelpFigure(props: { image: HelpImage; onZoom: (image: HelpImage) => void }) {
  return (
    <figure className="help-figure">
      <button className="help-figure-zoom" onClick={() => props.onZoom(props.image)} title="Click to enlarge">
        <img alt={props.image.caption} loading="lazy" src={props.image.src} />
      </button>
      <figcaption>{props.image.caption}</figcaption>
    </figure>
  );
}
