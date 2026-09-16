document.addEventListener("DOMContentLoaded", async () => {
  const list = document.getElementById("announcementsList");
  const badge = document.getElementById("countBadge");
  const adminAction = document.getElementById("adminAction");
  let currentUser = null;

  /**
   * Initialize Page
   */
  async function init() {
    try {
      // 1. Fetch Session
      const session = await window.api.fetch("/api/session");
      currentUser = session.user;

      // 2. Setup Role-Based UI (Post Button)
      // Checks for 'admin' or 'rep' roles
      if (
        currentUser &&
        (currentUser.role === "admin" || currentUser.role === "rep")
      ) {
        if (adminAction) {
          adminAction.innerHTML = `
                        <a href="create-announcement.html" class="btn btn-primary btn-sm rounded-pill animate__animated animate__fadeIn">
                            <i class="bi bi-plus-lg"></i> Post New
                        </a>`;
        }
      }

      // 3. Load Data
      await loadAnnouncements();
    } catch (e) {
      console.error("Initialization failed:", e);
      // If session fails, we still try to load public announcements
      await loadAnnouncements();
    }
  }

  window.goBack = function () {
    if (!currentUser) {
      // Fallback if session is lost
      window.location.href = "index.html";
      return;
    }

    // 1. Check for Admin first
    if (currentUser.role === "admin") {
      window.location.href = "admin.html";
      return;
    }

    // 2. Check for Rep / Leader / Creator status
    // Using the boolean flags from your session data
    if (
      currentUser.is_rep ||
      currentUser.is_leader ||
      currentUser.is_creator ||
      currentUser.role === "rep"
    ) {
      window.location.href = "rep-dashboard.html";
      return;
    }

    // 3. Default for standard students
    window.location.href = "dashboard-modern.html";
  };
  /**
   * Fetch and Render Announcements
   */
  async function loadAnnouncements() {
    try {
      list.innerHTML = `<div class="text-center py-5"><div class="spinner-border text-primary" role="status"></div></div>`;

      const data = await window.api.fetch("/api/announcements");
      // The API returns a plain array; be defensive in case it ever wraps it.
      const items = Array.isArray(data) ? data : data.announcements || [];

      if (badge) badge.textContent = `${items.length} Updates`;

      if (items.length === 0) {
        list.innerHTML = `
                    <div class="empty-state animate__animated animate__fadeIn">
                        <i class="bi bi-megaphone text-muted display-4"></i>
                        <p class="mt-3">No updates today. Check back later!</p>
                    </div>`;
        return;
      }

      list.innerHTML = items
        .map(
          (item) => `
                <div class="col-12 animate__animated animate__fadeInUp">
                    <div class="announcement-card p-3 shadow-sm">
                        <div class="status-strip ${item.is_global ? "bg-global" : "bg-local"}"></div>
                        <div class="d-flex justify-content-between">
                            <h6 class="fw-bold mb-1">${item.title}</h6>
                            ${item.is_new ? '<span class="badge bg-danger pulse-badge">NEW</span>' : ""}
                        </div>
                        <p class="small text-muted mb-2">${item.content}</p>
                        <div class="author-info d-flex align-items-center">
                            <i class="bi bi-person-circle me-1"></i>
                            <span>${item.author_name || "Campus Admin"} • ${new Date(item.created_at).toLocaleDateString()}</span>
                        </div>
                    </div>
                </div>
            `,
        )
        .join("");
    } catch (err) {
      console.error("Load error:", err);
      renderError();
    }
  }

  /**
   * Error State Handler
   */
  function renderError() {
    if (list) {
      list.innerHTML = `
                <div class="text-center py-5 animate__animated animate__headShake">
                    <i class="bi bi-exclamation-triangle display-4 text-danger"></i>
                    <p class="mt-3 fw-semibold">Failed to load broadcast.</p>
                    <p class="small text-muted">Please check your internet connection.</p>
                    <button onclick="location.reload()" class="btn btn-outline-primary btn-sm rounded-pill mt-2">
                        <i class="bi bi-arrow-clockwise"></i> Try Again
                    </button>
                </div>`;
    }
  }

  // Launch!
  init();
});
