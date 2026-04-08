(function () {
	'use strict';

	function formatExposureTime(val) {
		if (val == null) return null;
		if (val >= 1) return val + 's';
		var denom = Math.round(1 / val);
		return '1/' + denom + 's';
	}

	function formatFNumber(val) {
		if (val == null) return null;
		return 'f/' + (Number.isInteger(val) ? val + '.0' : val);
	}

	function formatFocalLength(val) {
		if (val == null) return null;
		return (Number.isInteger(val) ? val : val.toFixed(1)) + 'mm';
	}

	function formatDate(val) {
		if (val == null) return null;
		if (val instanceof Date) {
			return val.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
		}
		if (typeof val === 'string') return val;
		return null;
	}

	function populateMetadata(meta) {
		var infoEl = document.getElementById('camera-info');
		var rawEl = document.getElementById('metadata-content');

		// Raw JSON for power users
		rawEl.textContent = JSON.stringify(meta, null, 2);

		if (!meta || Object.keys(meta).length === 0) {
			infoEl.innerHTML = '<div class="info-row"><span class="info-label">No metadata available</span></div>';
			return;
		}

		var fields = [];

		// Camera
		var camera = [meta.Make, meta.Model].filter(Boolean).join(' ');
		// Avoid duplicating make in model (e.g. "Canon Canon EOS R5")
		if (meta.Make && meta.Model && meta.Model.indexOf(meta.Make) === 0) {
			camera = meta.Model;
		}
		if (camera) fields.push(['Camera', camera]);

		// Lens
		var lens = meta.LensModel || meta.Lens || meta.LensInfo;
		if (lens) fields.push(['Lens', typeof lens === 'string' ? lens : String(lens)]);

		// Focal length
		var fl = formatFocalLength(meta.FocalLength);
		if (fl) fields.push(['Focal Length', fl]);

		// Aperture
		var fn = formatFNumber(meta.FNumber);
		if (fn) fields.push(['Aperture', fn]);

		// Shutter speed
		var ss = formatExposureTime(meta.ExposureTime);
		if (ss) fields.push(['Shutter Speed', ss]);

		// ISO
		var iso = meta.ISO;
		if (iso != null) fields.push(['ISO', 'ISO ' + iso]);

		// Exposure compensation
		var ec = meta.ExposureCompensation;
		if (ec != null && ec !== 0) fields.push(['Exp. Comp.', (ec > 0 ? '+' : '') + ec + ' EV']);

		// White balance
		var wb = meta.WhiteBalance;
		if (wb != null) fields.push(['White Balance', wb === 0 ? 'Auto' : typeof wb === 'string' ? wb : 'Manual']);

		// Date
		var date = formatDate(meta.DateTimeOriginal || meta.CreateDate || meta.ModifyDate);
		if (date) fields.push(['Date', date]);

		// Software
		if (meta.Software) fields.push(['Software', meta.Software]);

		if (fields.length === 0) {
			infoEl.innerHTML = '<div class="info-row"><span class="info-label">No camera info found</span></div>';
			return;
		}

		var html = '';
		for (var i = 0; i < fields.length; i++) {
			html += '<div class="info-row">' +
				'<span class="info-label">' + fields[i][0] + '</span>' +
				'<span class="info-value">' + fields[i][1] + '</span>' +
				'</div>';
		}
		infoEl.innerHTML = html;
	}

	// --- Message handler: receive data from extension, switch from loading to viewer ---
	window.addEventListener('message', function (event) {
		var msg = event.data;
		if (msg.type === 'loaded') {
			document.getElementById('loading-container').style.display = 'none';
			document.body.classList.remove('loading');
			var viewer = document.getElementById('viewer-container');
			viewer.style.display = '';
			document.getElementById('preview-image').src = msg.jpegDataUri;
			var origW = msg.originalWidth || msg.width;
			var origH = msg.originalHeight || msg.height;
			var infoText = origW + ' &times; ' + origH;
			if (origW !== msg.width || origH !== msg.height) {
				infoText += ' (preview ' + msg.width + ' &times; ' + msg.height + ')';
			}
			document.getElementById('image-info').innerHTML = infoText;
			populateMetadata(msg.metadata);
			initViewer();
		} else if (msg.type === 'error') {
			document.getElementById('loading-container').style.display = 'none';
			document.body.classList.remove('loading');
			document.body.classList.add('error');
			var errEl = document.getElementById('error-container');
			errEl.style.display = '';
			document.getElementById('error-message').textContent = msg.message;
		}
	});

	var viewerInitialized = false;
	function initViewer() {
		if (viewerInitialized) return;
		viewerInitialized = true;

	var img = document.getElementById('preview-image');
	var container = document.getElementById('image-container');
	var metaPanel = document.getElementById('metadata-panel');
	var zoomLabel = document.getElementById('zoom-level');

	const btnFit = document.getElementById('btn-zoom-fit');
	const btnActual = document.getElementById('btn-zoom-100');
	const btnIn = document.getElementById('btn-zoom-in');
	const btnOut = document.getElementById('btn-zoom-out');
	const btnMeta = document.getElementById('btn-toggle-meta');

	let scale = 1;
	let minScale = 0.1;
	let translateX = 0;
	let translateY = 0;
	let isPanning = false;
	let panStartX = 0;
	let panStartY = 0;
	let panStartTransX = 0;
	let panStartTransY = 0;
	let fitMode = true;

	function updateTransform() {
		if (fitMode) {
			img.style.transform = '';
			img.style.maxWidth = '100%';
			img.style.maxHeight = '100%';
			img.style.cursor = 'zoom-in';
			container.style.overflow = 'hidden';
		} else {
			img.style.maxWidth = 'none';
			img.style.maxHeight = 'none';
			img.style.transform = 'translate(' + translateX + 'px, ' + translateY + 'px) scale(' + scale + ')';
			img.style.cursor = scale > 1 ? 'grab' : 'zoom-in';
			container.style.overflow = 'hidden';
		}
		zoomLabel.textContent = fitMode ? 'Fit' : Math.round(scale * 100) + '%';
	}

	function setScale(newScale, centerX, centerY) {
		fitMode = false;
		var oldScale = scale;
		scale = Math.max(minScale, Math.min(newScale, 32));

		// Zoom towards the cursor position
		if (centerX !== undefined && centerY !== undefined) {
			var rect = container.getBoundingClientRect();
			var cx = centerX - rect.left;
			var cy = centerY - rect.top;
			translateX = cx - (cx - translateX) * (scale / oldScale);
			translateY = cy - (cy - translateY) * (scale / oldScale);
		}

		updateTransform();
	}

	function fitToWindow() {
		fitMode = true;
		scale = 1;
		translateX = 0;
		translateY = 0;
		updateTransform();
	}

	function zoomActual(centerX, centerY) {
		if (centerX !== undefined && centerY !== undefined && fitMode) {
			// Transitioning from fit mode: CSS max-width/max-height scaling
			// means the stored scale (1) doesn't reflect the actual visual scale.
			// Compute translate from the image's rendered position directly.
			var imgRect = img.getBoundingClientRect();
			var containerRect = container.getBoundingClientRect();

			// Normalized click position within the displayed image (0 to 1)
			var nx = Math.max(0, Math.min(1, (centerX - imgRect.left) / imgRect.width));
			var ny = Math.max(0, Math.min(1, (centerY - imgRect.top) / imgRect.height));

			// Click position relative to the container
			var cx = centerX - containerRect.left;
			var cy = centerY - containerRect.top;

			// In non-fit mode the image is centered by flexbox at natural size.
			// Element top-left (before transform) relative to container:
			var elemLeft = (containerRect.width - img.naturalWidth) / 2;
			var elemTop = (containerRect.height - img.naturalHeight) / 2;

			// Set translate so the clicked image point stays at the click position
			fitMode = false;
			scale = 1;
			translateX = cx - elemLeft - nx * img.naturalWidth;
			translateY = cy - elemTop - ny * img.naturalHeight;
			updateTransform();
		} else if (centerX !== undefined && centerY !== undefined) {
			// Already in zoom mode: use ratio-based focal point math
			setScale(1, centerX, centerY);
		} else {
			translateX = 0;
			translateY = 0;
			setScale(1);
		}
	}

	// --- Toolbar buttons ---
	btnFit.addEventListener('click', fitToWindow);
	btnActual.addEventListener('click', zoomActual);
	btnIn.addEventListener('click', function () { setScale(scale * 1.25); });
	btnOut.addEventListener('click', function () { setScale(scale / 1.25); });

	// --- EXIF toggle ---
	btnMeta.addEventListener('click', function () {
		var visible = metaPanel.style.display !== 'none';
		metaPanel.style.display = visible ? 'none' : 'flex';
		btnMeta.classList.toggle('active', !visible);
	});

	// --- Mouse wheel zoom ---
	container.addEventListener('wheel', function (e) {
		e.preventDefault();
		var factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
		setScale(scale * factor, e.clientX, e.clientY);
	}, { passive: false });

	// --- Pan with mouse drag (left-click or middle-click) ---
	container.addEventListener('mousedown', function (e) {
		var isMiddle = e.button === 1;
		if (fitMode && !isMiddle) {
			// Left-click in fit mode → zoom to 100% centered on click point
			zoomActual(e.clientX, e.clientY);
			return;
		}
		if (!fitMode || isMiddle) {
			isPanning = true;
			panStartX = e.clientX;
			panStartY = e.clientY;
			panStartTransX = translateX;
			panStartTransY = translateY;
			img.style.cursor = 'grabbing';
			e.preventDefault();
		}
	});

	// Prevent middle-click default (auto-scroll icon)
	container.addEventListener('auxclick', function (e) {
		if (e.button === 1) e.preventDefault();
	});

	window.addEventListener('mousemove', function (e) {
		if (!isPanning) return;
		translateX = panStartTransX + (e.clientX - panStartX);
		translateY = panStartTransY + (e.clientY - panStartY);
		updateTransform();
	});

	window.addEventListener('mouseup', function () {
		if (isPanning) {
			isPanning = false;
			img.style.cursor = scale > 1 ? 'grab' : 'zoom-in';
		}
	});

	var PAN_STEP = 80;

	function pan(dx, dy) {
		if (fitMode) return;
		translateX += dx;
		translateY += dy;
		updateTransform();
	}

	// --- Keyboard shortcuts ---
	window.addEventListener('keydown', function (e) {
		if (e.key === '0') fitToWindow();
		else if (e.key === '1') zoomActual();
		else if (e.key === '+' || e.key === '=') setScale(scale * 1.25);
		else if (e.key === '-') setScale(scale / 1.25);
		else if (e.key === 'i' || e.key === 'I') btnMeta.click();
		else if (e.key === 'ArrowUp') { e.preventDefault(); pan(0, PAN_STEP); }
		else if (e.key === 'ArrowDown') { e.preventDefault(); pan(0, -PAN_STEP); }
		else if (e.key === 'ArrowLeft') { e.preventDefault(); pan(PAN_STEP, 0); }
		else if (e.key === 'ArrowRight') { e.preventDefault(); pan(-PAN_STEP, 0); }
	});

	// --- Double-click to toggle fit/100% ---
	container.addEventListener('dblclick', function (e) {
		if (fitMode) {
			zoomActual(e.clientX, e.clientY);
		} else {
			fitToWindow();
		}
	});

	// Initialize in fit mode
	fitToWindow();
	} // end initViewer
})();
