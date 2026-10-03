---
layout: base.njk
title: Contact
description: Questions, ideas, or want to run a local AI catchup in your city? Send us a message.
fullWidth: true
formTitle: Get in touch
formDescription: Questions, ideas, or want to run a catchup in your city? Send us a message.
formName: contact
formToolName: contact-local-ai
formToolDescription: Send a message to the local AI community organisers.
formSentTitle: Thanks!
formSentMessage: We'll get back to you soon.
formFields:
  - name
  - email
  - message
---

<section class="contact-hero">
<div class="hero-content">
<h1 class="hero-main">{{ formTitle }}</h1>
<p class="hero-minor">{{ formDescription }}</p>
</div>
{% include "partials/form.njk" %}
</section>
