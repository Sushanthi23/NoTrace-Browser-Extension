// ====================================
// NoTrace - Common UI Controller
// Shared UI Utilities: Toasts, Loaders, State Toggles, Dynamic Year
// ====================================

(function () {

  function ensureToastContainer() {
    let container = document.getElementById("notrace-toast-container");
    if (!container) {
      container = document.createElement("div");
      container.id = "notrace-toast-container";
      container.setAttribute("role", "status");
      container.setAttribute("aria-live", "polite");
      document.body.appendChild(container);
    }
    return container;
  }

  window.showNoTraceToast = function (message, type = "success", duration = 3000) {
    try {
      if (!document.body) {
        document.addEventListener("DOMContentLoaded", () =>
          window.showNoTraceToast(message, type, duration)
        );
        return;
      }

      const container = ensureToastContainer();

      const existing = container.querySelector(".notrace-toast");
      if (existing) existing.remove();

      const toast = document.createElement("div");
      toast.className = `notrace-toast ${type}`;
      toast.setAttribute("role", "alert");
      toast.setAttribute("aria-live", "assertive");

      const icons = { success: "✅", error: "❌", warning: "⚠️", info: "ℹ️" };
      const icon = icons[type] || "ℹ️";

      toast.innerHTML = `
        <span class="notrace-toast-icon">${icon}</span>
        <span class="notrace-toast-message">${message}</span>
      `;

      container.appendChild(toast);

      // ✅ FIX: double rAF ensures element is painted before adding .show
      requestAnimationFrame(() => requestAnimationFrame(() => toast.classList.add("show")));

      setTimeout(() => {
        toast.classList.remove("show");
        setTimeout(() => toast.remove(), 400);
      }, duration);

    } catch (err) {
      console.error("[NoTrace] Toast Error:", err);
    }
  };

  window.showToast = window.showNoTraceToast;

  window.addEventListener("notrace:toast", (e) => {
    const { message, type, duration } = e.detail || {};
    window.showNoTraceToast(message || "Notification", type || "info", duration || 3000);
  });

  window.showLoader = function (elementId) {
    try {
      const el = document.getElementById(elementId);
      if (el) { el.style.display = "flex"; el.setAttribute("aria-busy", "true"); }
    } catch (err) {
      console.error(`[NoTrace] showLoader failed: ${elementId}`, err);
    }
  };

  window.hideLoader = function (elementId) {
    try {
      const el = document.getElementById(elementId);
      if (el) { el.style.display = "none"; el.setAttribute("aria-busy", "false"); }
    } catch (err) {
      console.error(`[NoTrace] hideLoader failed: ${elementId}`, err);
    }
  };

  window.toggleTableState = function (tableId, show) {
    try {
      const table = document.getElementById(tableId);
      if (table) {
        table.style.display = show ? "table" : "none";
        table.setAttribute("aria-hidden", String(!show));
      }
    } catch (err) {
      console.error(`[NoTrace] toggleTableState failed: ${tableId}`, err);
    }
  };

  window.toggleEmptyState = function (id, show) {
    try {
      const el = document.getElementById(id);
      if (el) {
        el.style.display = show ? "block" : "none";
        el.setAttribute("aria-hidden", String(!show));
      }
    } catch (err) {
      console.error(`[NoTrace] toggleEmptyState failed: ${id}`, err);
    }
  };

  function updateYear() {
    try {
      const year = new Date().getFullYear();
      ["year", "notrace-year"].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = year;
      });
    } catch (err) {
      console.warn("[NoTrace] Year updater skipped:", err);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", updateYear);
  } else {
    updateYear();
  }

})();

