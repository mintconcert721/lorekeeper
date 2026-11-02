// 예시 세계관에 가족·세력·생몰년을 넣는다
module.exports = async (page) => {
  await page.evaluate(() => new Promise((res, rej) => {
    const wid = JSON.parse(localStorage.getItem("lk.world"));
    const r = indexedDB.open("lorekeeper", 1);
    r.onsuccess = () => {
      const db = r.result;
      const tx = db.transaction("kv", "readwrite");
      const st = tx.objectStore("kv");
      const q = st.get("entries:" + wid);
      q.onsuccess = () => {
        const list = q.result;
        const now = Date.now();
        const mk = (id, type, name, summary, relations = [], when) => ({ id, type, name, aliases: [], summary, fields: {}, body: "", tags: [], relations, status: "canon", ...(when ? { when } : {}), createdAt: now, updatedAt: now, updatedBy: "user", history: [] });
        const seori = list.find((e) => e.id === "C-001");
        seori.relations.push({ to: "C-010", label: "어머니" }, { to: "C-011", label: "아버지" }, { to: "C-012", label: "동생" });
        seori.when = { start: 305, end: null, label: "" };
        list.push(
          mk("C-010", "character", "하람", "서리의 어머니", [{ to: "C-011", label: "남편" }], { start: 280, end: 318, label: "" }),
          mk("C-011", "character", "도윤", "서리의 아버지, 전 등대지기", [{ to: "C-013", label: "스승" }], { start: 276, end: 330, label: "" }),
          mk("C-012", "character", "나래", "서리의 여동생", [{ to: "C-010", label: "어머니" }, { to: "C-011", label: "아버지" }], { start: 309, end: null, label: "" }),
          mk("C-013", "character", "노을", "도윤의 스승, 첫 등대지기", [], { start: 240, end: 301, label: "" }),
          mk("F-002", "faction", "등대 교단", "등대의 불을 섬기는 교단", [{ to: "F-001", label: "숙적" }, { to: "F-003", label: "동맹" }]),
          mk("F-003", "faction", "해안 공화국", "항구 도시들의 연합", [{ to: "F-002", label: "후원 대상" }]),
          mk("E-001", "event", "대등화", "등대가 처음 꺼진 밤", [], { start: 312, end: null, label: "" }),
          mk("E-002", "event", "안개 전쟁", "무등회와 교단의 싸움", [], { start: 318, end: 324, label: "" }),
        );
        st.put(list, "entries:" + wid);
        const wq = st.get("worlds");
        wq.onsuccess = () => {
          const ws = wq.result; const w = ws.find((x) => x.id === wid);
          w.counters = { ...(w.counters || {}), C: 13, F: 3, E: 2 };
          w.calendar = { ...(w.calendar || {}), now: 320 };
          st.put(ws, "worlds");
        };
      };
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    };
  }));
};
