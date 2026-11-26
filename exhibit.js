// 展示のページで共通の道具
window.Exhibit = (function () {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const get = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const set = (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch (e) { } };
  async function load() { const r = await fetch('data.json', { cache: 'no-store' }); return r.json(); }
  const participant = () => get('participant');
  const setParticipant = (v) => set('participant', v);
  // 番号がある人は、番号と絵の順番で条件を回す（ラテン方格）。番号がない人は、いつも「ガイドと音あり」
  function condition(data, index) {
    const p = parseInt(participant(), 10);
    if (!p) return 'all';
    const c = data.conditions || ['picture', 'guide', 'all'];
    return c[((p - 1) + index) % c.length];
  }
  return { esc, load, participant, setParticipant, condition };
})();
