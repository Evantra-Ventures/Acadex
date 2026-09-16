(function () {
  const form = document.getElementById("repDashUploadForm");
  const alertBox = document.getElementById("alert");
  const coursesSlides = document.getElementById("repDashCoursesSlides");
  const coursesEmpty = document.getElementById("repDashCoursesEmpty");
  const masterVaultGrid = document.getElementById("masterVaultGrid");

  const statCourses = document.getElementById("statCourses");
  const statSlides = document.getElementById("statSlides");
  const statRecent = document.getElementById("statRecent");

  const selTitle = document.getElementById("repDashCourseTitle");
  const addTitleBtn = document.getElementById("repDashAddTitleBtn");
  const newTitleInput = document.getElementById("repDashNewTitle");

  let currentUser = null;

  const apiFetch = async (url, options = {}) => {
    if (window.api && typeof window.api.fetch === "function") {
      return window.api.fetch(url, options);
    }
    const response = await fetch(url, options);
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    return response.json();
  };

  function showAlert(type, msg) {
    if (!alertBox) return;
    alertBox.className = `alert alert-${type}`;
    alertBox.textContent = msg;
    alertBox.classList.remove("d-none");
    if (type === "success") {
      setTimeout(() => alertBox.classList.add("d-none"), 5000);
    }
  }

  function extractYouTubeId(value) {
    if (!value) return null;
    const str = String(value).trim();
    const patterns = [
      /(?:youtu\.be\/)([A-Za-z0-9_-]{11})/,
      /(?:youtube\.com\/watch\?v=)([A-Za-z0-9_-]{11})/,
      /(?:youtube\.com\/embed\/)([A-Za-z0-9_-]{11})/,
      /(?:youtube\.com\/v\/)([A-Za-z0-9_-]{11})/,
      /([A-Za-z0-9_-]{11})/,
    ];
    for (const re of patterns) {
      const match = str.match(re);
      if (match && match[1]) return match[1];
    }
    return null;
  }

  function getFileIcon(url) {
    if (!url) return "bi-link-45deg";
    const lower = url.toLowerCase();
    if (lower.includes(".pdf")) return "bi-file-earmark-pdf";
    if (lower.includes(".ppt") || lower.includes(".pptx"))
      return "bi-file-earmark-ppt";
    return "bi-file-earmark-text";
  }

  // 1. Core Profile Sync
  async function initSession() {
    try {
      const data = await apiFetch("/api/session");
      currentUser = data && data.user ? data.user : null;
      if (!currentUser) {
        window.location.replace("index.html");
        return;
      }

      const raw =
        currentUser.fullName ||
        currentUser.name ||
        currentUser.username ||
        currentUser.studentId ||
        "Rep";
      const firstName =
        currentUser.firstName || String(raw).trim().split(/\s+/)[0] || "Rep";

      const nameEls = document.querySelectorAll(
        "#repWelcomeName, .sidebar .fw-bold, #profileName",
      );
      nameEls.forEach((el) => (el.textContent = firstName));

      const av = document.getElementById("repAvatar");
      if (av) av.src = "/images/avatar.png";
    } catch (err) {
      console.error("Session init error:", err);
    }
  }

  // 2. Global Core Master Vault Sync
  async function loadMasterVault() {
    if (!masterVaultGrid) return;

    masterVaultGrid.innerHTML = `
        <div class="col-12 text-center py-4 text-white-50">
            <div class="spinner-border spinner-border-sm text-success me-2" role="status"></div> Loading Master Vault catalogs...
        </div>`;

    try {
      if (!currentUser) return;

      let rawProgram =
        currentUser.program_id ||
        currentUser.program ||
        "informationtechnology";
      let dbProgramId = String(rawProgram)
        .toLowerCase()
        .replace(/\s+/g, "")
        .trim();
      if (!dbProgramId) dbProgramId = "informationtechnology";

      const currentLevel =
        parseInt(currentUser.currentLevel || currentUser.current_level || currentUser.level, 10) || 100;

      const masterUrl = `/api/resources?master=true&programId=${encodeURIComponent(dbProgramId)}&level=${encodeURIComponent(currentLevel)}`;
      const masterData = await apiFetch(masterUrl);
      const masterResources = Array.isArray(masterData.resources)
        ? masterData.resources
        : [];

      if (masterResources.length > 0) {
        masterVaultGrid.innerHTML = masterResources
          .map((res, index) => {
            let actionBtn = "";
            let mediaPreview = "";
            const youTubeId = extractYouTubeId(res.youtube_id || res.youtubeId);

            if (youTubeId) {
              mediaPreview = `
                <div class="youtube-thumb position-relative" style="cursor:pointer;" onclick="window.open('https://youtube.com/watch?v=${youTubeId}', '_blank')">
                    <img src="https://img.youtube.com/vi/${youTubeId}/hqdefault.jpg" class="card-img-top rounded-top-4" style="height: 140px; object-fit: cover;">
                    <div class="position-absolute top-50 start-50 translate-middle text-white"><i class="bi bi-play-circle-fill display-6 text-danger"></i></div>
                </div>`;
              actionBtn = `<button class="btn btn-sm btn-outline-danger w-100 rounded-pill" onclick="window.open('https://youtube.com/watch?v=${youTubeId}', '_blank')"><i class="bi bi-youtube me-1"></i>Watch Now</button>`;
            } else {
              mediaPreview = `<div class="p-4 text-center bg-light border-bottom rounded-top-4"><i class="bi ${getFileIcon(res.url)} display-6 text-success"></i></div>`;
              actionBtn = `<a href="${res.url}" target="_blank" class="btn btn-sm btn-success w-100 rounded-pill"><i class="bi bi-cloud-arrow-down me-1"></i>Open Resource</a>`;
            }

            return `
                <div class="col-12 col-md-4 col-lg-3 animate__animated animate__fadeInUp" style="animation-delay: ${index * 0.05}s">
                    <div class="card h-100 shadow-sm border-0 rounded-4 overflow-hidden">
                        ${mediaPreview}
                        <div class="card-body d-flex flex-column justify-content-between">
                            <h6 class="fw-bold mb-2 text-truncate text-dark" title="${res.title}">${res.title}</h6>
                            <div class="mt-2">${actionBtn}</div>
                        </div>
                    </div>
                </div>`;
          })
          .join("");
      } else {
        masterVaultGrid.innerHTML = `
            <div class="col-12 text-center py-5 text-white-50 bg-dark bg-opacity-10 rounded-4 border border-secondary border-opacity-10">
                <i class="bi bi-folder-x fs-3 d-block mb-2 text-muted"></i>
                No core tracking reference resources found on target identifier pathway: "${dbProgramId}".
            </div>`;
      }
    } catch (err) {
      console.error("Master Vault execution breakdown:", err);
      masterVaultGrid.innerHTML = `<div class="col-12 text-center text-danger py-4">Error sync updating tracking track pathway assets.</div>`;
    }
  }

  function renderTitlesSelect(titles) {
    if (!selTitle) return;
    selTitle.innerHTML = '<option value="">Select a course title</option>';
    (titles || []).forEach((t) => {
      const opt = document.createElement("option");
      opt.value = t;
      opt.textContent = t;
      selTitle.appendChild(opt);
    });
  }

  async function loadMyTitles() {
    try {
      const data = await apiFetch("/api/courses/mine");
      const titles = Array.isArray(data.titles) ? data.titles : [];
      renderTitlesSelect(titles);
    } catch (e) {
      renderTitlesSelect([]);
    }
  }

  addTitleBtn?.addEventListener("click", () => {
    newTitleInput.classList.toggle("d-none");
    const addingNew = !newTitleInput.classList.contains("d-none");
    if (addingNew) {
      if (selTitle) {
        selTitle.value = "";
        selTitle.setAttribute("disabled", "disabled");
      }
      newTitleInput.focus();
    } else {
      selTitle?.removeAttribute("disabled");
    }
  });

  async function loadCourses() {
    if (!coursesSlides) return;
    coursesSlides.innerHTML =
      '<div class="text-center p-3 text-white-50">Loading catalog...</div>';
    coursesEmpty.classList.add("d-none");

    try {
      const data = await apiFetch("/api/courses");
      const courses = Array.isArray(data.courses) ? data.courses : [];

      if (!courses.length) {
        coursesSlides.innerHTML = "";
        coursesEmpty.classList.remove("d-none");
        statCourses.textContent = "0";
        statSlides.textContent = "0";
        statRecent.textContent = "0";
        return;
      }

      coursesSlides.innerHTML = "";
      let totalSlides = 0;
      let recentCount = 0;
      const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

      for (let i = 0; i < courses.length; i++) {
        const course = courses[i];
        const slidesResp = await apiFetch(
          `/api/slides?courseTitle=${encodeURIComponent(course)}`,
        );
        const slides = Array.isArray(slidesResp.slides)
          ? slidesResp.slides
          : [];

        totalSlides += slides.length;
        recentCount += slides.filter((s) => {
          const t = Date.parse(s.createdAt || s.created_at);
          return !Number.isNaN(t) && t >= sevenDaysAgo;
        }).length;

        const card = document.createElement("div");
        card.className = "accordion-item";
        card.innerHTML = `
          <h2 class="accordion-header" id="heading${i}">
            <button class="accordion-button collapsed" type="button" data-bs-toggle="collapse" data-bs-target="#collapse${i}">
              <span class="fw-semibold text-dark">${course}</span> 
              <span class="badge rounded-pill bg-primary ms-2">${slides.length}</span>
            </button>
          </h2>
          <div id="collapse${i}" class="accordion-collapse collapse" data-bs-parent="#repDashCoursesSlides">
            <div class="accordion-body p-0 text-dark">
              <ul class="list-group list-group-flush mb-0">
                ${
                  slides.length === 0
                    ? `<li class="list-group-item text-muted small">No slides available.</li>`
                    : slides
                        .map(
                          (s) => `
                    <li class="list-group-item d-flex justify-content-between align-items-center bg-transparent">
                      <div class="text-truncate me-2">
                        <div class="fw-semibold text-dark small">${s.slideTitle || s.originalName || "Untitled Slide"}</div>
                        <small class="text-muted" style="font-size: 0.75rem;">${new Date(s.createdAt || s.created_at).toLocaleDateString()}</small>
                      </div>
                      <div class="btn-group shadow-sm">
                        <button class="btn btn-sm btn-outline-primary" data-action="download" data-id="${s.id}"><i class="bi bi-download"></i></button>
                        <button class="btn btn-sm btn-outline-secondary" data-action="view" data-id="${s.id}"><i class="bi bi-eye"></i></button>
                      </div>
                    </li>`,
                        )
                        .join("")
                }
              </ul>
            </div>
          </div>`;
        coursesSlides.appendChild(card);
      }

      statCourses.textContent = courses.length;
      statSlides.textContent = totalSlides;
      statRecent.textContent = recentCount;

      coursesSlides.querySelectorAll("button[data-action]").forEach((btn) => {
        btn.addEventListener("click", async (e) => {
          e.preventDefault();
          const id = btn.getAttribute("data-id");
          const action = btn.getAttribute("data-action");
          if (!id) return showAlert("danger", "Resource ID missing.");

          try {
            const resp = await apiFetch(
              `/api/slides/${encodeURIComponent(id)}/url`,
            );
            if (!resp || !resp.url) throw new Error("URL not found");
            if (action === "view") {
              window.open(resp.url, "_blank");
            } else {
              const a = document.createElement("a");
              a.href = resp.url;
              a.download = "";
              document.body.appendChild(a);
              a.click();
              a.remove();
            }
          } catch (err) {
            showAlert("danger", "Unable to access file. Please refresh.");
          }
        });
      });
    } catch (e) {
      coursesSlides.innerHTML =
        '<div class="text-danger p-3">Error loading catalog.</div>';
    }
  }

  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!currentUser)
      return showAlert("danger", "Session expired. Please login again.");

    const selectedTitle = selTitle?.value ? String(selTitle.value).trim() : "";
    const newTitle =
      !newTitleInput.classList.contains("d-none") && newTitleInput.value
        ? String(newTitleInput.value).trim()
        : "";
    const finalCourseTitle = newTitle || selectedTitle;
    const slideTitle = document
      .getElementById("repDashSlideTitle")
      ?.value.trim();

    if (!finalCourseTitle)
      return showAlert("danger", "Select or enter a course title.");
    if (!slideTitle) return showAlert("danger", "Provide a slide title.");

    const fd = new FormData(form);
    fd.set("courseTitle", finalCourseTitle);
    fd.set("slideTitle", slideTitle);

    fd.set(
      "institution_id",
      currentUser.institution_id || currentUser.institutionId || "",
    );
    fd.set("program_id", currentUser.program || currentUser.program_id || "");
    fd.set(
      "class_group_id",
      currentUser.class_group_id || currentUser.classGroupId || "",
    );

    try {
      if (newTitle) {
        try {
          await apiFetch("/api/courses/manage", {
            method: "POST",
            body: {
              title: newTitle,
              courseTitle: newTitle,
            },
          });
        } catch (err) {
          console.error("Course title creation failed:", err);
          showAlert("danger", "Failed to initialize new course category.");
          return;
        }
      }

      await apiFetch("/api/upload", { method: "POST", body: fd });
      showAlert("success", "Resource uploaded successfully!");

      form.reset();
      newTitleInput.classList.add("d-none");
      selTitle?.removeAttribute("disabled");

      await loadMyTitles();
      await loadCourses();
    } catch (err) {
      showAlert("danger", err.message || "Upload failed.");
    }
  });

  async function handleLogout() {
    if (confirm("Sign out of the Rep Dashboard?")) {
      try {
        await apiFetch("/api/logout", { method: "POST" });
      } catch (err) {}
      window.location.href = "/index.html";
    }
  }

  document
    .getElementById("repLogoutBtn")
    ?.addEventListener("click", handleLogout);
  document
    .getElementById("mobileLogoutBtn")
    ?.addEventListener("click", handleLogout);
  document
    .getElementById("repDashRefreshCourses")
    ?.addEventListener("click", loadCourses);
  document
    .getElementById("refreshMasterVault")
    ?.addEventListener("click", loadMasterVault);

  async function runBootSequence() {
    try {
      await initSession();
      await loadMasterVault();
      await loadMyTitles();
      await loadCourses();

      if (
        window.api &&
        window.api.initPush &&
        Notification.permission === "granted"
      ) {
        await window.api.initPush({ prompt: false }).catch(() => {});
      }
    } catch (err) {
      console.error("Boot error:", err);
      if (coursesSlides)
        coursesSlides.innerHTML =
          '<div class="text-danger p-3">System offline.</div>';
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", runBootSequence);
  } else {
    runBootSequence();
  }
})();
