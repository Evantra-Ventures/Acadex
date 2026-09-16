(function () {
  let selectedCourseId = null;
  let selectedCourseName = "";

  const apiFetch = async (url, options = {}) => {
    if (window.api && typeof window.api.fetch === "function") {
      return window.api.fetch(url, options);
    }
    const response = await fetch(url, options);
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    return response.json();
  };

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

  // --- LIFECYCLE 1: LOAD MASTER VAULT GLOBALLY FOR THE STUDENT ---
  async function loadMasterVault() {
    const masterVaultGrid = document.getElementById("masterVaultGrid");
    if (!masterVaultGrid) return;

    masterVaultGrid.innerHTML = `
            <div class="col-12 text-center py-4 text-white-50">
                <div class="spinner-border spinner-border-sm text-success me-2" role="status"></div> Loading your Master Vault catalog...
            </div>`;

    try {
      const session = await apiFetch("/api/session");
      const u = session?.user;
      if (!u) {
        window.location.replace("index.html");
        return;
      }


      const raw = u.fullName || u.full_name || u.name || u.username || u.studentId || "Student";
      const firstName = u.firstName || u.first_name || String(raw).trim().split(/\s+/)[0] || "Student";

      const profileNameEls = document.querySelectorAll(".sidebar .fw-bold, #profileName, .user-name, #repWelcomeName, #user-firstname, #welcomeStudentName");
      profileNameEls.forEach(el => {
         el.textContent = firstName;
      });

  
      const profileBadgeEl = document.querySelector(".sidebar .badge, #profileBadge, .user-program, #user-course");
      if (profileBadgeEl) {
        profileBadgeEl.textContent = u.program || "Information Technology";
      }


      let rawProgram = u.program_id || u.program || "informationtechnology";

      let dbProgramId = String(rawProgram)
        .toLowerCase()
        .replace(/\s+/g, "")
        .trim();

      if (!dbProgramId) {
        dbProgramId = "informationtechnology";
      }

      const currentLevel = parseInt(u.currentLevel || u.current_level || u.level, 10) || 100;

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
              actionBtn = `<a href="${res.url}" target="_blank" class="btn btn-sm btn-success w-100 rounded-pill"><i class="bi bi-cloud-arrow-down me-1"></i>Open Master Resource</a>`;
            }

            return `
                        <div class="col-12 col-md-4 col-lg-3 animate__animated animate__fadeInUp" style="animation-delay: ${index * 0.05}s">
                            <div class="card h-100 shadow-sm border-0 rounded-4 overflow-hidden">
                                ${mediaPreview}
                                <div class="card-body d-flex flex-column justify-content-between">
                                    <h6 class="fw-bold mb-2 text-truncate" title="${res.title}">${res.title}</h6>
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
                        No verified core master reference items found matching the track pathway code: "${dbProgramId}" (Level ${currentLevel}).
                    </div>`;
      }
    } catch (err) {
      console.error("Master Vault processing breakdown:", err);
      masterVaultGrid.innerHTML = `<div class="col-12 text-center text-danger py-4">Error fetching core vault track assets.</div>`;
    }
  }

  // --- LIFECYCLE 2: LOAD COURSE SLIDES ONLY (WHEN A STUDENT CLICKS A COURSE) ---
  async function loadSlides() {
    const slidesList = document.getElementById("slidesList");
    const slidesEmpty = document.getElementById("slidesEmpty");
    if (!slidesList || !slidesEmpty) return;

    slidesList.innerHTML = "";
    slidesEmpty.classList.add("d-none");

    if (!selectedCourseId) {
      slidesEmpty.classList.remove("d-none");
      return;
    }

    try {
      const fallbackData = await apiFetch(
        `/api/slides?courseTitle=${encodeURIComponent(selectedCourseName)}`,
      );
      const standardSlides = Array.isArray(fallbackData.slides)
        ? fallbackData.slides
        : [];

      if (standardSlides.length > 0) {
        standardSlides.forEach((s) => {
          const li = document.createElement("li");
          li.className =
            "list-group-item d-flex justify-content-between align-items-center p-3 border-start border-4 border-info-subtle";

          const cleanTitle =
            s.title || s.slideTitle || s.originalName || "Untitled Document";
          const metaCaption = `Class Rep Contribution • ${new Date(s.createdAt || s.created_at).toLocaleDateString()}`;

          li.innerHTML = `
                        <div class="d-flex align-items-center overflow-hidden me-2">
                            <i class="bi bi-file-earmark-pdf-fill text-danger fs-3 me-3 flex-shrink-0"></i>
                            <div class="text-truncate">
                                <span class="fw-bold d-block text-dark text-truncate" title="${cleanTitle}">${cleanTitle}</span>
                                <small class="text-muted d-block text-truncate">${metaCaption}</small>
                            </div>
                        </div>
                        <button type="button" class="btn btn-primary btn-sm px-3 rounded-pill view-btn"><i class="bi bi-eye me-1"></i> View</button>
                    `;

          li.querySelector(".view-btn").addEventListener("click", async () => {
            try {
              const linkResolution = await apiFetch(`/api/slides/${s.id}/url`);
              if (linkResolution?.url)
                window.open(linkResolution.url, "_blank");
            } catch (err) {
              alert("Failed to securely open target item file pathway.");
            }
          });

          slidesList.appendChild(li);
        });
      } else {
        slidesEmpty.classList.remove("d-none");
      }
    } catch (err) {
      console.error("Class Rep Contribution pipeline error:", err);
      slidesList.innerHTML = `<li class="list-group-item text-center text-danger p-3">Error fetching course slides context.</li>`;
    }
  }

  async function loadCourses() {
    const coursesList = document.getElementById("coursesList");
    const coursesEmpty = document.getElementById("coursesEmpty");
    if (!coursesList) return;

    try {
      const data = await apiFetch("/api/courses");
      const courses = Array.isArray(data.courses) ? data.courses : [];

      if (!courses.length) {
        if (coursesEmpty) coursesEmpty.classList.remove("d-none");
        return;
      }

      coursesList.innerHTML = "";
      courses.forEach((courseTitle) => {
        const li = document.createElement("li");
        li.className =
          "list-group-item list-group-item-action course-card d-flex align-items-center py-3";

        const spaceIndex = courseTitle.indexOf(" ");
        const displayCode =
          spaceIndex !== -1 ? courseTitle.substring(0, spaceIndex) : "COURSE";
        const displayName =
          spaceIndex !== -1
            ? courseTitle.substring(spaceIndex + 1)
            : courseTitle;

        li.innerHTML = `
                    <i class="bi bi-bookmark-star-fill me-3" style="color:#06b6d4; font-size:1.2rem;"></i> 
                    <div class="overflow-hidden">
                        <span class="fw-bold d-block mb-0 text-truncate">${displayCode}</span>
                        <small class="text-muted text-uppercase text-truncate d-block" style="font-size: 0.7rem">${displayName}</small>
                    </div>
                `;

        li.addEventListener("click", () => {
          selectedCourseId = courseTitle;
          selectedCourseName = courseTitle;

          const titleEl = document.getElementById("slidesCourseTitle");
          if (titleEl) titleEl.textContent = courseTitle;

          document
            .querySelectorAll(".course-card")
            .forEach((el) => el.classList.remove("active"));
          li.classList.add("active");

          loadSlides();
        });
        coursesList.appendChild(li);
      });
    } catch (err) {
      console.error(err);
    }
  }


  async function handleLogout() {
    try {
      await apiFetch("/api/logout", { method: "POST" });
    } catch (e) {
      console.warn("API logout context fallback redirecting manually.");
    }
    window.location.replace("index.html");
  }

  // --- UNIFIED BOOT SEQUENCE ---
  function initializeDashboard() {
    loadMasterVault();
    loadCourses();

    const refreshCourses = document.getElementById("refreshCourses");
    const refreshSlides = document.getElementById("refreshSlides");
    if (refreshCourses) refreshCourses.addEventListener("click", loadCourses);
    if (refreshSlides) refreshSlides.addEventListener("click", loadSlides);


    const dskLogout = document.getElementById("logoutBtn");
    const mobLogout = document.getElementById("mobileLogoutBtn");
    if (dskLogout) dskLogout.addEventListener("click", handleLogout);
    if (mobLogout) mobLogout.addEventListener("click", handleLogout);
  }

  // Safe Lifecycle initialization check
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initializeDashboard);
  } else {
    initializeDashboard();
  }
})();