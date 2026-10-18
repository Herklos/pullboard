/** The approved Roadmap header, displaying the backend's summary without deriving board counts [N26]. */
export function roadmapSummary(milestone, context = {}) {
  /** Escape supplied milestone text before placing it in HTML or attributes. */
  const escape = text => String(text ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
  const summary = milestone.summary;
  const states = [['landed','landed'],['landing','accepted, landing'],['review','in review'],['building','building'],['waiting','waiting for an agent'],['held','held']];
  /** Accept only nonnegative integer counts from the backend contract. */
  const number = value => Number.isInteger(value) && value >= 0;
  if (!summary || !number(summary.total) || !number(summary.left) || states.some(([key]) => !number(summary[key]))) return null;
  const count = '<span class="roadmap-left"><b>'+escape(summary.left)+' left</b><span aria-label="'+escape(summary.landed)+'/'+escape(summary.total)+' landed">'+escape(summary.landed)+' of '+escape(summary.total)+' landed</span></span>';
  const description = states.map(([key,label]) => summary[key]+' '+label).join(', ');
  let offset = 0;
  const segments = states.map(([key]) => { const x = offset; offset += summary[key]; return '<rect class="roadmap-summary-segment ' + key + '" data-summary-segment="' + key + '" data-count="' + summary[key] + '" x="' + x + '" width="' + summary[key] + '" height="1"/>'; }).join('');
  // Geometry uses the supplied counts as SVG units; inline CSS is disallowed by the view's policy.
  const bar = '<svg class="milestone-progress roadmap-summary-bar" viewBox="0 0 ' + (summary.total || 1) + ' 1" preserveAspectRatio="none" role="img" aria-label="' + escape(milestone.name+': '+description) + '" data-total="' + summary.total + '">' + segments + '</svg>';
  const legend = '<div class="roadmap-summary-legend">'+states.map(([key,label]) => '<span data-summary-state="'+key+'"><i class="roadmap-summary-swatch '+key+'" aria-hidden="true"></i><b>'+escape(summary[key])+'</b> '+label+'</span>').join('')+'</div>';
  const target = milestone.target ? '<span class="roadmap-target">Target <time datetime="'+escape(milestone.target)+'">'+escape(context.time ? context.time(milestone.target) : milestone.target)+'</time>'+(milestone.pastTarget?' <span class="chip warn">past target</span>':'')+'</span>' : '';
  const estimate = summary.estimate, pace = summary.pace;
  const measured = estimate && Number.isFinite(estimate.low) && Number.isFinite(estimate.high) && pace && number(pace.last6h) && number(pace.last2h);
  const forecast = measured ? '<span class="roadmap-estimate">About '+escape(estimate.low)+' to '+escape(estimate.high)+' h at today’s pace</span><span class="roadmap-pace">'+escape(pace.last6h)+' landed in the last 6 h, '+escape(pace.last2h)+' in the last 2 h</span>' : '';
  const meta = target || forecast ? '<div class="roadmap-summary-meta">'+target+forecast+'</div>' : '';
  const needs = Array.isArray(summary.needsYou) ? summary.needsYou.map(id => {
    const item = context.lookup ? context.lookup(id) : null;
    const text = escape(item?.label || '#'+id)+(item?.title?' '+escape(item.title):'');
    return item?.address ? '<a class="ref" href="'+escape(item.address)+'" data-go="item:'+escape(item.id)+'"'+(item.board?' data-board="'+escape(item.board)+'"':'')+'>'+text+'</a>' : '<span>'+text+'</span>';
  }).join(', ') : '';
  return { count, detail: '<div class="roadmap-summary">'+bar+legend+meta+(needs?'<div class="roadmap-summary-needs"><b>Needs you:</b> '+needs+'</div>':'')+'</div>' };
}
