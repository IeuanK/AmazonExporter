// ==UserScript==
// @name         Amazon Order Exporter
// @version      0.4.1
// @description  Export Amazon order history to JSON/CSV
// @author       IeuanK
// @url          https://github.com/IeuanK/AmazonExporter/raw/main/AmazonExporter.user.js
// @updateURL    https://github.com/IeuanK/AmazonExporter/raw/main/AmazonExporter.user.js
// @downloadURL  https://github.com/IeuanK/AmazonExporter/raw/main/AmazonExporter.user.js
// @supportURL   https://github.com/IeuanK/AmazonExporter/issues
// @match        https://www.amazon.com/*
// @match        https://www.amazon.de/*
// @match        https://www.amazon.co.uk/*
// @match        https://www.amazon.nl/*
// @grant        none
// ==/UserScript==

(function () {
    "use strict";

    // Main state management
    const STATE_KEY = "amazonOrderExporter";
    let state = {
        lastUpdate: null,
        total: 0,
        captures: 0,
        lastOrder: null,
        orders: {},
    };

    const conLog = (...args) => {
        console.log(`[Amazon Exporter]: `, ...args);
    };
    const conError = (...args) => {
        console.error(`[Amazon Exporter Error]: `, ...args);
    };

    // Load state from localStorage
    const loadState = () => {
        const saved = localStorage.getItem(STATE_KEY);
        if (saved) {
            state = JSON.parse(saved);
        }
        return state;
    };

    // Save state to localStorage
    const saveState = () => {
        localStorage.setItem(STATE_KEY, JSON.stringify(state));
    };

    // Check if pagination is loaded
    const isPaginationLoaded = () => {
        return !!document.querySelector(".a-pagination") || !!document.querySelector("ul.a-pagination");
    };

    // Check if we can proceed with operations
    const checkReadiness = () => {
        const pagination = isPaginationLoaded();
        const buttons = document.querySelectorAll("button");
        buttons.forEach(button => {
            button.disabled = !pagination;
        });
        return pagination;
    };

    // URL handling
    const getNextPageUrl = () => {
        // First try to get it from pagination
        const currentPage = document.querySelector(".a-pagination .a-selected");
        if (currentPage) {
            const nextPageLi = currentPage.nextElementSibling;
            if (nextPageLi && nextPageLi.querySelector("a")) {
                return nextPageLi.querySelector("a").href;
            }
        }

        // Fallback to URL manipulation if pagination not found
        const url = new URL(window.location.href);
        const startIndex = new URLSearchParams(url.search).get("startIndex") || "0";
        const newStartIndex = parseInt(startIndex) + 10;
        url.searchParams.set("startIndex", newStartIndex);
        return url.toString();
    };

    // CSV conversion
    const getCSV = (data = null) => {
        if (!data) {
            data = getJSON();
        }
        const orders = Object.values(data.orders);
        if (orders.length === 0) return "";
    
        // Headers
        const headers = ["OrderId", "Date", "Payee", "Notes", "Total", "Currency", "ItemCount"];
    
        // Create rows
        const rows = [];
        orders.forEach(order => {
            const itemNotes = order.items.map(item => 
                `${item.qty}x ${item.name} - ${item.status || "Unknown"}`
            ).join(", ");
            
            rows.push([
                order.orderId,
                order.orderDate,
                `Amazon`,
                `${order.orderId} - ${itemNotes}`,
                order.totalPrice,
                order.currency,
                order.items.length
            ].map(value => `"${value}"`)); // Wrap in quotes to handle commas in text
        });
    
        return [headers.join(","), ...rows.map(row => row.join(","))].join("\n");
    };

    // JSON export
    const getJSON = () => {
        return loadState();
    };

    // Get item details including quantity
    const getItemDetails = (itemBox) => {
        // Try various possible title selectors
        let titleElem = itemBox.querySelector(".yohtmlc-product-title") || itemBox.querySelector(".a-link-normal");
        if (!titleElem) {
            throw new Error("Could not find item title");
        }

        const name = titleElem.textContent.trim() || titleElem.getAttribute("title").trim();

        // Check for quantity indicator with fallbacks
        const qtyElem = itemBox.querySelector(".product-image .product-image__qty, .quantity");
        const qty = qtyElem ? parseInt(qtyElem.textContent.trim(), 10) : 1;

        if (!name || !name.length || !qty) {
            throw new Error("Could not extract item details");
        }

        return {
            name: name,
            qty: qty,
        };
    };

    // Data capture
    const capturePage = async (captureButton) => {
        // Initialize tracking
        captureButton.disabled = true;
        const tracking = {
            total: 0,
            captured: 0,
            failed: 0,
            skipped: 0,
        };

        // Find status span and update it
        const statusSpan = document.querySelector(".capture-status");
        const updateStatus = () => {
            if (statusSpan) {
                statusSpan.textContent = `${tracking.captured}/${tracking.total} orders captured, ${tracking.failed} failed, ${tracking.skipped} skipped`;
            }
        };

        // Load current state
        loadState();

        // Initialize orders object for this page
        const newOrders = {};

        // Find all order cards on the page
        const orderCards = document.querySelectorAll(".order-card");
        if (!orderCards.length) {
            conLog("No orders found on page");
            captureButton.disabled = false;
            return false;
        }

        tracking.total = orderCards.length;

        for (const orderCard of orderCards) {
            try {
                // Get the order header box
                const orderHeader = orderCard.querySelector(".order-header") || orderCard.querySelector(".a-box.order-info");
                if (!orderHeader) {
                    throw new Error("Could not find order header or order info");
                }

                // Extract order ID (407-1881395-0003506 format)
                const orderIdElem = orderHeader.querySelector(".yohtmlc-order-id span[dir=\"ltr\"], .yohtmlc-order-id bdi[dir=\"ltr\"]");
                if (!orderIdElem) {
                    throw new Error("Could not find order ID");
                }
                const orderId = orderIdElem.textContent.trim();

                // Skip if already captured
                if (state.orders[orderId]) {
                    tracking.skipped++;
                    // Add orange border for skipped orders
                    const boxGroup = orderCard.querySelector(".a-box-group");
                    if (boxGroup) {
                        boxGroup.style.border = "2px solid #ffa500";
                    }
                    updateStatus();
                    continue;
                }

                // Extract total price (€33.98 format)
                const priceElem = orderHeader.querySelector(".a-column.a-span2 .a-size-base, .yohtmlc-order-total .value");
                if (!priceElem) {
                    throw new Error("Could not find price element");
                }
                const priceText = priceElem.textContent.trim();
                const currency = priceText.startsWith("€") ? "EUR" : "USD";
                const totalPrice = parseFloat(priceText.replace(/[^0-9.,]/g, "").replace(",", "."));

                // Extract order date
                const dateElem = orderHeader.querySelector(".a-column.a-span3 .a-size-base, .a-column.a-span3 .value");
                if (!dateElem) {
                    throw new Error("Could not find date element");
                }
                const dateText = dateElem.textContent.trim();
                const dateParts = dateText.split(" ");
                const day = parseInt(dateParts[0]);
                const month = {
                    "January": 0, "February": 1, "March": 2, "April": 3, "May": 4, "June": 5,
                    "July": 6, "August": 7, "September": 8, "October": 9, "November": 10, "December": 11,
                }[dateParts[1]];
                const year = parseInt(dateParts[2]);
                const date = new Date(year, month, day);
                const orderDate = date.toISOString().split("T")[0];

                // Initialize items array for this order
                const items = [];

                // First try delivery boxes, then fallback to shipment boxes
                const deliveryBoxes = orderCard.querySelectorAll(".delivery-box, .shipment");
                deliveryBoxes.forEach(deliveryBox => {
                    // Get delivery status from either standard or alternative elements
                    const statusElem = deliveryBox.querySelector(".delivery-box__primary-text, .a-size-medium.a-color-base.a-text-bold");
                    if (!statusElem) {
                        throw new Error("Could not find status element");
                    }

                    const statusText = statusElem.textContent.trim();
                    const [status, dateStr] = statusText.split(" ").filter(Boolean);

                    let formattedStatusDate = null;
                    if(statusText.indexOf('today') > -1) {
                        let today = new Date();
                        formattedStatusDate = `${(today.getMonth() + 1).toString().padStart(2, "0")}-${today.getDate().toString().padStart(2, "0")}`;
                    } else if (statusText.indexOf('tomorrow') > -1) {
                        let tomorrow = new Date();
                        tomorrow.setDate(tomorrow.getDate() + 1);
                        formattedStatusDate = `${(tomorrow.getMonth() + 1).toString().padStart(2, "0")}-${tomorrow.getDate().toString().padStart(2, "0")}`;
                    } else if (statusText.indexOf('yesterday') > -1) {
                        let yesterday = new Date();
                        yesterday.setDate(yesterday.getDate() - 1);
                        formattedStatusDate = `${(yesterday.getMonth() + 1).toString().padStart(2, "0")}-${yesterday.getDate().toString().padStart(2, "0")}`;
                    } else {
                        // Format date as MM-DD
                        const statusDateParts = statusText.split(" ").filter(Boolean);
                        const day = statusDateParts[1];
                        const month = statusDateParts[2];
                        if (day !== undefined && month !== undefined) {
                            const statusDateObj = new Date(`${month} ${day} 2024`);
                            formattedStatusDate = `${(statusDateObj.getMonth() + 1).toString().padStart(2, "0")}-${statusDateObj.getDate().toString().padStart(2, "0")}`;
                        } else {
                            formattedStatusDate = `${(date.getMonth() + 1).toString().padStart(2, "0")}-${date.getDate().toString().padStart(2, "0")}`;
                        }
                    }

                    // Process each item in this delivery - try both old and new item selectors
                    const itemBoxes = deliveryBox.querySelectorAll(".item-box, .yohtmlc-item");
                    itemBoxes.forEach(itemBox => {
                        const itemDetails = getItemDetails(itemBox);
                        items.push({
                            ...itemDetails,
                            status: status || "Old",
                            statusDate: formattedStatusDate,
                        });
                    });
                });

                newOrders[orderId] = {
                    orderId: orderId,
                    itemCount: items.length,
                    totalPrice: totalPrice,
                    currency: currency,
                    orderDate: orderDate,
                    items: items,
                };

                // Add green border for successfully captured orders
                const boxGroup = orderCard.querySelector(".a-box-group");
                if (boxGroup) {
                    boxGroup.style.border = "2px solid #00aa00";
                }

                tracking.captured++;

            } catch (err) {
                conError("Error processing order:", err);
                tracking.failed++;

                // Add visual error indication to the inner box
                const boxGroup = orderCard.querySelector(".a-box-group");
                if (boxGroup) {
                    boxGroup.style.border = "2px solid #ff0000";
                    boxGroup.style.position = "relative";
                    boxGroup.style.paddingBottom = "30px"; // Make room for error bar

                    // Create and add error bar
                    const errorBar = document.createElement("div");
                    errorBar.style.cssText = `
                    position: absolute;
                    bottom: 0;
                    left: 0;
                    right: 0;
                    background: #ff0000;
                    color: white;
                    padding: 5px 10px;
                    font-size: 12px;
                    z-index: 1;
                `;
                    errorBar.textContent = `Error: ${err.message}`;
                    boxGroup.appendChild(errorBar);
                }
            }

            // Small delay to prevent UI freezing
            await new Promise(resolve => setTimeout(resolve, 50));
        }

        const allOrders = { ...state.orders, ...newOrders };
        const sortedOrderIds = Object.keys(allOrders).sort((a, b) => {
            return new Date(allOrders[b].orderDate) - new Date(allOrders[a].orderDate);
        });

        state.orders = {};
        sortedOrderIds.forEach(orderId => {
            state.orders[orderId] = allOrders[orderId];
        });

        conLog(getCSV({ orders: newOrders }));

        if (tracking.captured > 0) {
            // Update state
            state.lastUpdate = new Date().toISOString().replace("T", " ").substring(0, 19);
            state.captures++;
            state.total = Object.keys(state.orders).length;
            state.lastOrder = Object.keys(newOrders)[0];

            // Save updated state
            saveState();
        }

        // Re-enable button after short delay
        setTimeout(() => {
            captureButton.disabled = false;
        }, 2000);

        return tracking.captured > 0;
    };
    // UI Components
    const createPanel = () => {
        const panel = document.createElement("div");
        panel.style.cssText = `
            position: fixed;
            bottom: 20px;
            left: 20px;
            background: white;
            border: 1px solid #ccc;
            padding: 15px;
            border-radius: 5px;
            box-shadow: 0 2px 5px rgba(0,0,0,0.2);
            z-index: 10000;
            min-width: 200px;
        `;
        return panel;
    };

    const createConfirmDialog = (message, onConfirm) => {
        const overlay = document.createElement("div");
        overlay.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0, 0, 0, 0.5);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 10001;
        `;

        const dialog = document.createElement("div");
        dialog.style.cssText = `
            background: white;
            padding: 20px;
            border-radius: 5px;
            box-shadow: 0 2px 10px rgba(0, 0, 0, 0.3);
            max-width: 400px;
            text-align: center;
        `;

        const text = document.createElement("p");
        text.textContent = message;
        text.style.marginBottom = "20px";

        const buttonContainer = document.createElement("div");
        buttonContainer.style.display = "flex";
        buttonContainer.style.justifyContent = "center";
        buttonContainer.style.gap = "10px";

        const confirmButton = document.createElement("button");
        confirmButton.textContent = "Yes, delete all";
        confirmButton.style.cssText = `
            padding: 8px 16px;
            border: none;
            border-radius: 3px;
            background: #ff4444;
            color: white;
            cursor: pointer;
        `;
        confirmButton.addEventListener("mouseover", () => confirmButton.style.background = "#ff6666");
        confirmButton.addEventListener("mouseout", () => confirmButton.style.background = "#ff4444");
        confirmButton.addEventListener("click", () => {
            onConfirm();
            document.body.removeChild(overlay);
        });

        const cancelButton = document.createElement("button");
        cancelButton.textContent = "Cancel";
        cancelButton.style.cssText = `
            padding: 8px 16px;
            border: 1px solid #ccc;
            border-radius: 3px;
            background: white;
            cursor: pointer;
        `;
        cancelButton.addEventListener("mouseover", () => cancelButton.style.background = "#f0f0f0");
        cancelButton.addEventListener("mouseout", () => cancelButton.style.background = "white");
        cancelButton.addEventListener("click", () => document.body.removeChild(overlay));

        buttonContainer.appendChild(cancelButton);
        buttonContainer.appendChild(confirmButton);
        dialog.appendChild(text);
        dialog.appendChild(buttonContainer);
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
    };
    const createPreviewModal = (content, type) => {
        const overlay = document.createElement("div");
        overlay.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.7);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 10001;
    `;

        const modal = document.createElement("div");
        modal.style.cssText = `
        background: white;
        padding: 20px;
        border-radius: 5px;
        box-shadow: 0 2px 10px rgba(0, 0, 0, 0.3);
        max-width: 80%;
        max-height: 80%;
        overflow: auto;
    `;

        const closeButton = document.createElement("button");
        closeButton.textContent = "Close";
        closeButton.style.cssText = `
        position: absolute;
        top: 10px;
        right: 10px;
        padding: 5px 10px;
        background: #f44336;
        color: white;
        border: none;
        border-radius: 3px;
        cursor: pointer;
    `;
        closeButton.onclick = () => document.body.removeChild(overlay);

        if (type === "json") {
            const pre = document.createElement("pre");
            const code = document.createElement("code");
            code.textContent = content;
            pre.appendChild(code);
            modal.appendChild(pre);
        } else if (type === "csv") {
            const table = document.createElement("table");
            table.style.borderCollapse = "collapse";
            const rows = content.split("\n");
            rows.forEach((row, index) => {
                const tr = document.createElement("tr");
                let splitString = `,`;
                if(row.indexOf(`","`) !== -1) {
                    splitString = `","`;
                }
                row.split(splitString).forEach(cell => {
                    const td = document.createElement(index === 0 ? "th" : "td");
                    td.textContent = cell.replace(/^"|"$/g, "");
                    td.style.border = "1px solid #ddd";
                    td.style.padding = "8px";
                    tr.appendChild(td);
                });
                table.appendChild(tr);
            });
            modal.appendChild(table);
        }

        modal.appendChild(closeButton);
        overlay.appendChild(modal);
        document.body.appendChild(overlay);
    };

    const createButton = (icon, tooltip, onClick) => {
        const button = document.createElement("button");
        button.innerHTML = icon;
        button.title = tooltip;
        button.style.cssText = `
            margin: 5px;
            padding: 8px;
            border: 1px solid #ccc;
            border-radius: 3px;
            cursor: pointer;
            background: #f8f8f8;
            width: 36px;
            height: 36px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            font-family: sans-serif;
            position: relative;
        `;

        // Add hover styles
        button.addEventListener("mouseover", () => {
            button.style.background = "#e9e9e9";
        });
        button.addEventListener("mouseout", () => {
            button.style.background = "#f8f8f8";
        });

        button.addEventListener("click", onClick);
        return button;
    };

    // Update panel UI based on state
    const updatePanelUI = (panel) => {
        // Clear panel
        panel.innerHTML = "";

        // Add title
        const title = document.createElement("div");
        title.textContent = "Amazon Order Exporter";
        title.style.cssText = `
            font-weight: bold;
            margin-bottom: 10px;
            font-size: 1.1em;
            color: #232f3e;
        `;
        panel.appendChild(title);

        // Show capture info with placeholder spaces
        const info = document.createElement("div");
        info.className = "captures-list";
        info.style.cssText = `
            margin: 10px 0;
            min-height: 80px;  /* Space for 4 lines */
        `;

        const state = loadState();
        info.innerHTML = `
            <div style="min-height: 20px">Total Orders: ${state.total || ""}</div>
            <div style="min-height: 20px">Pages Captured: ${state.captures || ""}</div>
            <div style="min-height: 20px">Last Update: ${state.lastUpdate || ""}</div>
        `;
        panel.appendChild(info);

        // Add status span for capture progress
        const statusSpan = document.createElement("div");
        statusSpan.className = "capture-status";
        statusSpan.style.cssText = `
            min-height: 20px;
            margin-bottom: 10px;
            color: #666;
            font-size: 0.9em;
        `;
        panel.appendChild(statusSpan);

        const buttonContainer = document.createElement("div");
        buttonContainer.style.display = "flex";
        buttonContainer.style.alignItems = "center";
        buttonContainer.style.gap = "5px";

        // Add control buttons
        const startButton = createButton(
            "📸",
            state.captures === 0 ? "Start Capturing" : "Capture Page",
            async () => {
                const captured = await capturePage(startButton);
                if (captured) {
                    updatePanelUI(panel);
                }
            },
        );

        const captureNextButton = createButton(
            "⏭️",
            "Capture & Next Page",
            async () => {
                captureNextButton.disabled = true;
                const captured = await capturePage(captureNextButton);
                setTimeout(() => {
                    window.location.href = getNextPageUrl();
                }, 1000);
            },
        );

        buttonContainer.appendChild(captureNextButton);

        const nextPageButton = createButton("➡️", "Next Page", () => {
            window.location.href = getNextPageUrl();
        });
        buttonContainer.appendChild(nextPageButton);

        const jsonButton = createButton("📥", "Export JSON", (event) => {
            const data = getJSON();
            if (event.shiftKey) {
                createPreviewModal(JSON.stringify(data, null, 2), "json");
            } else {
                const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `amazon_orders_${new Date().toISOString().split("T")[0]}.json`;
                a.click();
                URL.revokeObjectURL(url);
            }
        });
        buttonContainer.appendChild(jsonButton);

        const csvButton = createButton("📊", "Export CSV", (event) => {
            const csv = getCSV();
            if (event.shiftKey) {
                createPreviewModal(csv, "csv");
            } else {
                const blob = new Blob([csv], { type: "text/csv" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `amazon_orders_${new Date().toISOString().split("T")[0]}.csv`;
                a.click();
                URL.revokeObjectURL(url);
            }
        });
        buttonContainer.appendChild(csvButton);

        // Add clear data button
        const clearButton = createButton("❌", "Clear All Data", () => {
            createConfirmDialog("This will delete ALL captured data, are you sure?", () => {
                localStorage.removeItem(STATE_KEY);
                window.location.reload();
            });
        });
        clearButton.style.marginLeft = "auto"; // Push to right side
        buttonContainer.appendChild(clearButton);

        buttonContainer.appendChild(startButton);
        panel.appendChild(buttonContainer);
    };

    // Main initialization
    const init = () => {
        const panel = createPanel();
        updatePanelUI(panel);
        document.body.appendChild(panel);

        // Initial check
        if (!checkReadiness()) {
            // Set up a retry mechanism
            let attempts = 0;
            const maxAttempts = 20; // 10 seconds total (20 * 500ms)

            const checkInterval = setInterval(() => {
                attempts++;
                if (checkReadiness() || attempts >= maxAttempts) {
                    clearInterval(checkInterval);
                }
            }, 500);
        }
    };

    conLog(`Checking URL`);
    // Check if we're on an orders page
    if (
        window.location.href.match(/\/your-orders\/orders/) ||
        window.location.href.match(/\/order-history/)
    ) {
        try {
            conLog(`Loading script`);
            init();
        } catch (error) {
            conError(error);
        }
    }
})();
