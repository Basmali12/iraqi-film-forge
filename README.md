Current saved workflow and live-versus-local deployment status: [checkpoint](docs/CHECKPOINT-2026-10-28.md).

> Local active profile: LTX-2.5 DFR + Diffusion VAE. Conv is retired from the active service image. Text detection holds captioned scenes for review; experimental inpainting is disabled. See docs/DFR-MAIN-AND-TEXT-GATE.txt for rollout prerequisites and unverified boundaries.

# Iraqi Film Forge — ستوديو الأفلام العراقي

المسار الحالي: OpenAI للمخرج وكتابة القصة، وLTX-2.5 Distilled على Modal للفيديو والصوت الأصلي.
تقاعدت تكاملات مزود الفيديو السابق بإذن المستخدم في 28 أكتوبر 2026. محفوظات المشاريع والفيديوهات تبقى للعرض والتنزيل والدمج؛ لا إعادة توليد تلقائية.

الموقع الحالي: https://167.104.162.4/film.html
المستودع: https://github.com/Basmali12/iraqi-film-forge
GitHub Pages واجهة ثابتة فقط؛ لم تُحدَّث بهذا النشر.

الإعدادات: مفتاح OpenAI محفوظ مشفّراً بالخادم، وإدارة حسابات Modal. لا أسرار في Git أو تخزين المتصفح.
GPU: RTX PRO 6000، CPU4، RAM96GiB، إخراج720p، Conv VAE وصوت LTX الأصلي. تشغيل GPU والنقل يحتاجان موافقة واضحة على الكلفة.

فحوص مجانية: `npm run check`، `npm test`، `npm run build`، وPython unittest.
مكتبات Forge وFFmpeg وتجميع MP4 محفوظة لإعادة الاستخدام؛ محوّل التوليد السابق وCLI الخاص به أُزيلا.
الوثائق الأقدم تحت docs سجلات تاريخية، وليست وصفاً لمسارات تنفيذ متاحة الآن.
