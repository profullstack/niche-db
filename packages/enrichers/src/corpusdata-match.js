const STOP = new Set(
  'a an and are as at be by for from in into is of on or the to with'.split(' '),
);

const words = (value) =>
  new Set(
    String(value ?? '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 2 && !STOP.has(word)),
  );

const dateValue = (value) => {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.valueOf()) ? date : null;
};

const dateScore = (left, right) => {
  const a = dateValue(left);
  const b = dateValue(right);
  if (!a || !b) return null;
  const days = Math.abs(a - b) / 86_400_000;
  return days <= 1 ? 1 : days <= 7 ? 0.8 : days <= 31 ? 0.5 : 0;
};

const overlap = (a, b) => {
  if (!a.size || !b.size) return 0;
  let common = 0;
  for (const word of a) if (b.has(word)) common += 1;
  return common / Math.max(a.size, b.size);
};

/** Match one NicheDB event against CorpusData article records without guessing. */
export function matchCorpusArticles(item, articles, { threshold = 0.72, margin = 0.1 } = {}) {
  const title = String(item.title ?? '').trim();
  const aliases = [title, ...(item.data?.aliases ?? []), ...(item.data?.names ?? [])];
  const eventWords = new Set(aliases.flatMap((value) => [...words(value)]));
  const eventDate = item.published_at ?? item.data?.date ?? item.data?.startDate;
  const entities = new Set((item.data?.entities ?? []).map((value) => String(value).toLowerCase()));
  const ranked = (articles ?? [])
    .map((article) => {
      const articleTitle = article.title ?? article.headline ?? '';
      const articleWords = words(`${articleTitle} ${article.description ?? article.text ?? ''}`);
      const titleScore = Math.max(
        ...aliases.map((alias) => overlap(words(alias), words(articleTitle))),
        0,
      );
      const bodyScore = overlap(eventWords, articleWords);
      const date = dateScore(
        eventDate,
        article.date ?? article.published_at ?? article.publishedAt,
      );
      const articleEntities = new Set(
        (article.entities ?? []).map((value) => String(value).toLowerCase()),
      );
      const entityScore =
        entities.size && articleEntities.size ? overlap(entities, articleEntities) : null;
      const score =
        titleScore * 0.6 + bodyScore * 0.2 + (date ?? 0) * 0.15 + (entityScore ?? 0) * 0.05;
      return {
        article,
        score,
        reasons: [
          titleScore >= 0.8 ? 'strong-title-overlap' : titleScore >= 0.5 ? 'title-overlap' : null,
          bodyScore >= 0.4 ? 'body-overlap' : null,
          date === 1 ? 'same-day' : date === 0.8 ? 'same-week' : null,
          entityScore >= 0.5 ? 'entity-overlap' : null,
        ].filter(Boolean),
      };
    })
    .sort((a, b) => b.score - a.score);
  const best = ranked[0];
  const next = ranked[1];
  if (!best || best.score < threshold || (next && best.score - next.score < margin)) return null;
  return { ...best, confidence: Number(best.score.toFixed(3)) };
}
