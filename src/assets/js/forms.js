// /assets/js/forms.js: sends Netlify forms in the background and shows a thank-you card in place of the form.
// If an AI agent submitted the form (WebMCP toolautosubmit), it is told the result.
(function () {
  document.querySelectorAll("form[data-sent-message]").forEach((form) => {
    const card = document.createElement("div");
    card.setAttribute("role", "status");
    card.hidden = true;
    form.after(card);

    // Build the card with textContent so form text can't inject HTML
    const show = ({ icon, title, text, error }) => {
      card.className = `form-sent${form.dataset.sentAccent ? ` form-sent--${form.dataset.sentAccent}` : ""}${error ? " form-sent--error" : ""}`;
      card.replaceChildren(
        Object.assign(document.createElement("div"), { className: "form-sent__icon", innerHTML: `<i class="bi ${icon}" aria-hidden="true"></i>` }),
        Object.assign(document.createElement("h3"), { className: "form-sent__title", textContent: title }),
        Object.assign(document.createElement("p"), { className: "form-sent__text", textContent: text })
      );
      card.hidden = false;
    };

    // What the visitor sent, so they can see it after the form is gone
    const summary = (data) => {
      const list = document.createElement("dl");
      list.className = "form-sent__summary";
      for (const [name, value] of data) {
        const field = form.elements[name];
        if (!value || !field || field.type === "hidden" || field.closest("[hidden]")) continue;
        const label = form.querySelector(`label[for="${field.id}"]`);
        list.append(
          Object.assign(document.createElement("dt"), { textContent: label ? label.textContent.trim() : name }),
          Object.assign(document.createElement("dd"), { textContent: value })
        );
      }
      return list;
    };

    // "What next" links from a <template class="form-next"> next to the form
    const next = form.parentElement.querySelector("template.form-next");

    form.addEventListener("submit", (e) => {
      e.preventDefault();

      if (!form.checkValidity()) {
        const missing = [...form.elements].filter((el) => el.name && !el.checkValidity()).map((el) => el.name);
        if (e.agentInvoked) e.respondWith(Promise.resolve(`Not sent. Fill in: ${missing.join(", ")}.`));
        return;
      }

      const data = new FormData(form);
      const sent = "sentSummary" in form.dataset && summary(data);
      data.set("form-name", form.getAttribute("name"));

      const sending = fetch("/", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(data).toString()
      })
        .then((res) => {
          if (!res.ok) throw new Error(res.status);
          form.hidden = true;
          show({ icon: "bi-check2", title: form.dataset.sentTitle || "Thank you!", text: form.dataset.sentMessage });
          if (sent) card.append(sent);
          if (next) card.append(next.content.cloneNode(true));
          return `Sent. The visitor now sees: "${form.dataset.sentMessage}"`;
        })
        .catch(() => {
          show({ icon: "bi-exclamation-lg", title: "Something went wrong", text: "That didn't go through. Please try again in a moment.", error: true });
          return "Not sent: the form couldn't reach the server. Ask the visitor to try again later.";
        });

      if (e.agentInvoked) e.respondWith(sending);
    });

    // Typing again after an error clears the error card
    form.addEventListener("input", () => { if (card.classList.contains("form-sent--error")) card.hidden = true; });
  });
})();
