// SPDX-License-Identifier: GPL-2.0-or-later

// Tile glyphs drawn with cairo on a 16x16 grid, 1.5 stroke. Not icon files: the shell
// renders symbolic icons by filling every path, which turns outlines into blobs.

import Cairo from 'cairo';

const TAU = 2 * Math.PI;

function dot(context, centerX, centerY, radius) {
    context.newSubPath();
    context.arc(centerX, centerY, radius, 0, TAU);
    context.fill();
}

function ring(context, centerX, centerY, radius) {
    context.newSubPath();
    context.arc(centerX, centerY, radius, 0, TAU);
    context.stroke();
}

function line(context, fromX, fromY, toX, toY) {
    context.moveTo(fromX, fromY);
    context.lineTo(toX, toY);
    context.stroke();
}

function roundRect(context, left, top, width, height, radius) {
    const right = left + width;
    const bottom = top + height;
    context.newSubPath();
    context.arc(right - radius, top + radius, radius, -TAU / 4, 0);
    context.arc(right - radius, bottom - radius, radius, 0, TAU / 4);
    context.arc(left + radius, bottom - radius, radius, TAU / 4, TAU / 2);
    context.arc(left + radius, top + radius, radius, TAU / 2, 3 * TAU / 4);
    context.closePath();
}

// Top half of an ellipse, left to right, or right to left when reversed.
function halfEllipse(context, centerX, centerY, radiusX, radiusY, reversed = false) {
    context.save();
    context.translate(centerX, centerY);
    context.scale(radiusX, radiusY);
    if (reversed)
        context.arcNegative(0, 0, 1, TAU, TAU / 2);
    else
        context.arc(0, 0, 1, TAU / 2, TAU);
    context.restore();
}

const GLYPHS = {
    fan(context) {
        dot(context, 8, 8, 1.25);
        for (let blade = 0; blade < 3; blade++) {
            context.save();
            context.translate(8, 8);
            context.rotate(blade * TAU / 3);
            context.translate(-8, -8);
            context.moveTo(8, 6.5);
            context.curveTo(7.5, 4, 8.5, 2, 10.25, 2.25);
            context.curveTo(11.75, 2.5, 11.75, 4.25, 10, 5.5);
            context.closePath();
            context.fill();
            context.restore();
        }
    },

    bulb(context) {
        context.newSubPath();
        context.arc(8, 6.25, 4, 0.75 * Math.PI, 2.25 * Math.PI);
        context.lineTo(10, 10.5);
        context.lineTo(10, 11.25);
        context.lineTo(6, 11.25);
        context.lineTo(6, 10.5);
        context.closePath();
        context.stroke();
        line(context, 6.5, 13.5, 9.5, 13.5);
    },

    thermometer(context) {
        context.moveTo(6.5, 9.25);
        context.lineTo(6.5, 3.5);
        context.arc(8, 3.5, 1.5, Math.PI, TAU);
        context.lineTo(9.5, 9.25);
        context.arc(8, 11.5, 2.75, -0.983, 4.124);
        context.closePath();
        context.stroke();
        dot(context, 8, 11.5, 1);
    },

    motion(context) {
        dot(context, 4.5, 8, 1.4);
        context.newSubPath();
        context.arc(4.5, 8, 3.5, -0.85, 0.85);
        context.stroke();
        context.newSubPath();
        context.arc(4.5, 8, 6.5, -0.85, 0.85);
        context.stroke();
    },

    door(context) {
        context.moveTo(4, 14);
        context.lineTo(4, 2.75);
        context.lineTo(12, 2.75);
        context.lineTo(12, 14);
        context.stroke();
        line(context, 2.5, 14, 13.5, 14);
        dot(context, 9.75, 8.5, 0.9);
    },

    vacuum(context) {
        ring(context, 8, 8, 5.75);
        dot(context, 8, 5.25, 1.25);
    },

    drop(context) {
        context.moveTo(8, 2.25);
        context.curveTo(8, 2.25, 12.25, 6.75, 12.25, 10);
        context.arc(8, 10, 4.25, 0, Math.PI);
        context.curveTo(3.75, 6.75, 8, 2.25, 8, 2.25);
        context.closePath();
        context.stroke();
    },

    scale(context) {
        roundRect(context, 2.5, 2.5, 11, 11, 3);
        context.stroke();
        context.newSubPath();
        context.arc(8, 8.64, 2.75, -2.386, -0.756);
        context.stroke();
    },

    button(context) {
        roundRect(context, 3, 3, 10, 10, 3);
        context.stroke();
        dot(context, 8, 8, 1.75);
    },

    smoke(context) {
        ring(context, 8, 8, 5.75);
        dot(context, 8, 8, 2);
    },

    wifi(context) {
        dot(context, 8, 12.5, 1.1);
        for (const radius of [3.5, 6.5]) {
            context.newSubPath();
            context.arc(8, 12.5, radius, 1.25 * Math.PI, 1.75 * Math.PI);
            context.stroke();
        }
    },

    washer(context) {
        roundRect(context, 2.5, 2, 11, 12, 2);
        context.stroke();
        line(context, 2.5, 5, 13.5, 5);
        ring(context, 8, 9.5, 2.75);
        dot(context, 11, 3.5, 0.75);
    },

    dishwasher(context) {
        roundRect(context, 2.5, 2, 11, 12, 2);
        context.stroke();
        line(context, 2.5, 5.5, 13.5, 5.5);
        line(context, 6, 8, 10, 8);
        dot(context, 5, 3.75, 0.7);
        dot(context, 7.25, 3.75, 0.7);
    },

    purifier(context) {
        roundRect(context, 4, 2, 8, 12, 2.5);
        context.stroke();
        ring(context, 8, 5.25, 1.25);
        for (const y of [9, 11])
            line(context, 6.25, y, 9.75, y);
    },

    humidifier(context) {
        roundRect(context, 3.5, 8, 9, 6, 2.5);
        context.stroke();
        for (const x of [6, 10]) {
            context.moveTo(x, 6);
            context.curveTo(x - 1.25, 4.75, x + 1.25, 3.5, x, 2);
            context.stroke();
        }
    },

    dehumidifier(context) {
        roundRect(context, 3.5, 2, 9, 12, 2);
        context.stroke();
        line(context, 5.75, 4.75, 10.25, 4.75);
        context.moveTo(8, 7.25);
        context.curveTo(8, 7.25, 10, 9.25, 10, 10.5);
        context.arc(8, 10.5, 2, 0, Math.PI);
        context.curveTo(6, 9.25, 8, 7.25, 8, 7.25);
        context.closePath();
        context.stroke();
    },

    heater(context) {
        for (const x of [3.5, 6.5, 9.5, 12.5])
            line(context, x, 3, x, 12);
        line(context, 2.5, 13.75, 13.5, 13.75);
    },

    curtain(context) {
        line(context, 1.75, 2.5, 14.25, 2.5);
        context.moveTo(2.75, 2.5);
        context.lineTo(6.75, 2.5);
        context.curveTo(6, 6.5, 7, 10, 5.5, 13.5);
        context.lineTo(2.75, 13.5);
        context.closePath();
        context.stroke();
        context.moveTo(13.25, 2.5);
        context.lineTo(9.25, 2.5);
        context.curveTo(10, 6.5, 9, 10, 10.5, 13.5);
        context.lineTo(13.25, 13.5);
        context.closePath();
        context.stroke();
    },

    fridge(context) {
        roundRect(context, 4, 1.75, 8, 12.5, 1.75);
        context.stroke();
        line(context, 4, 6.25, 12, 6.25);
        line(context, 6, 3.5, 6, 4.5);
        line(context, 6, 8.25, 6, 10.25);
    },

    coffee(context) {
        context.moveTo(3, 6.5);
        context.lineTo(4, 13);
        context.lineTo(10, 13);
        context.lineTo(11, 6.5);
        context.closePath();
        context.stroke();
        context.newSubPath();
        context.arc(11, 9, 1.75, -TAU / 4, TAU / 4);
        context.stroke();
        for (const x of [5.5, 8.5]) {
            context.moveTo(x, 4.75);
            context.curveTo(x - 1, 3.75, x + 1, 2.75, x, 1.75);
            context.stroke();
        }
    },

    thermostat(context) {
        ring(context, 8, 8, 5.75);
        line(context, 8, 8, 10.25, 5.75);
        dot(context, 8, 8, 1.25);
    },

    doorbell(context) {
        roundRect(context, 5, 1.75, 6, 12.5, 3);
        context.stroke();
        ring(context, 8, 10.25, 1.4);
        dot(context, 8, 5, 0.9);
    },

    plant(context) {
        context.moveTo(4.5, 9.5);
        context.lineTo(5.5, 14);
        context.lineTo(10.5, 14);
        context.lineTo(11.5, 9.5);
        context.closePath();
        context.stroke();
        line(context, 8, 9.5, 8, 5.25);
        context.moveTo(8, 7.25);
        context.curveTo(6.5, 7.25, 4.5, 6.25, 4.5, 4);
        context.curveTo(6.5, 4, 8, 5.25, 8, 7.25);
        context.stroke();
        context.moveTo(8, 5.5);
        context.curveTo(9.5, 5.5, 11.5, 4.5, 11.5, 2.25);
        context.curveTo(9.5, 2.25, 8, 3.5, 8, 5.5);
        context.stroke();
    },

    cooker(context) {
        roundRect(context, 2.5, 7, 11, 6.5, 2.5);
        context.stroke();
        context.newSubPath();
        context.arc(8, 7, 5, Math.PI, 0);
        context.stroke();
        line(context, 6.5, 10.25, 9.5, 10.25);
    },

    filter(context) {
        roundRect(context, 4.5, 2, 7, 12, 2);
        context.stroke();
        context.moveTo(8, 5);
        context.curveTo(8, 5, 10, 7.25, 10, 8.75);
        context.arc(8, 8.75, 2, 0, Math.PI);
        context.curveTo(6, 7.25, 8, 5, 8, 5);
        context.closePath();
        context.stroke();
    },

    dot(context) {
        dot(context, 8, 8, 2.5);
    },
    appliance(context) {
        roundRect(context, 3, 2.5, 10, 11, 2.5);
        context.stroke();
        line(context, 5.75, 5.5, 10.25, 5.5);
        dot(context, 8, 9.5, 1.25);
    },

    pot(context) {
        line(context, 2.75, 6.5, 13.25, 6.5);
        context.moveTo(4, 6.5);
        context.lineTo(4, 11.25);
        context.arcNegative(6.25, 11.25, 2.25, Math.PI, Math.PI / 2);
        context.lineTo(9.75, 13.5);
        context.arcNegative(9.75, 11.25, 2.25, Math.PI / 2, 0);
        context.lineTo(12, 6.5);
        context.stroke();
        line(context, 1.75, 8.5, 4, 8.5);
        line(context, 12, 8.5, 14.25, 8.5);
        dot(context, 8, 4.75, 1);
    },

    kettle(context) {
        context.moveTo(4.75, 13.5);
        context.lineTo(5.75, 5);
        context.lineTo(10.25, 5);
        context.lineTo(11.25, 13.5);
        context.closePath();
        context.stroke();
        line(context, 5.4, 8, 2.75, 5.75);
        context.newSubPath();
        context.arc(11, 8.75, 2.25, -TAU / 4, TAU / 4);
        context.stroke();
        dot(context, 8, 3.5, 1);
    },

    scooter(context) {
        ring(context, 3.75, 12.25, 1.75);
        ring(context, 12.25, 12.25, 1.75);
        line(context, 3.75, 12.25, 10.5, 12.25);
        line(context, 12.25, 12.25, 10, 2.75);
        line(context, 8.25, 2.75, 11.25, 2.75);
    },

    shield(context) {
        context.moveTo(8, 2);
        context.lineTo(13, 3.75);
        context.lineTo(13, 7.75);
        context.curveTo(13, 10.75, 10.75, 12.75, 8, 14);
        context.curveTo(5.25, 12.75, 3, 10.75, 3, 7.75);
        context.lineTo(3, 3.75);
        context.closePath();
        context.stroke();
    },

    lock(context) {
        roundRect(context, 3.5, 7, 9, 7, 1.75);
        context.stroke();
        context.newSubPath();
        context.arc(8, 6, 2.5, Math.PI, 0);
        context.lineTo(10.5, 7);
        context.moveTo(5.5, 7);
        context.lineTo(5.5, 6);
        context.stroke();
    },

    swing(context) {
        line(context, 2.5, 10, 13.5, 10);
        context.moveTo(5, 7.5);
        context.lineTo(2.5, 10);
        context.lineTo(5, 12.5);
        context.moveTo(11, 7.5);
        context.lineTo(13.5, 10);
        context.lineTo(11, 12.5);
        context.stroke();
        dot(context, 8, 4.5, 1.5);
    },

    // Nook's logo: a roof over an arched doorway with the light on. Filled shapes only, so
    // tools/icon.js can write it to icons/nook-symbolic.svg; see the note at the top.
    nook(context) {
        // The door sits up and right of its arch, as in icons/nook-logo.svg.
        context.moveTo(5.3, 14.2);
        halfEllipse(context, 9.4, 8.8, 4.1, 3.4);
        context.lineTo(13.5, 14.2);
        context.closePath();
        context.fill();

        context.moveTo(0.42, 6.63);
        context.lineTo(8, 0.23);
        context.lineTo(15.58, 6.63);
        context.lineTo(14.62, 7.77);
        context.lineTo(8, 2.18);
        context.lineTo(1.38, 7.77);
        context.closePath();
        context.fill();
        dot(context, 0.9, 7.2, 0.75);
        dot(context, 15.1, 7.2, 0.75);

        context.moveTo(3.15, 14.2);
        halfEllipse(context, 8, 9.9, 4.85, 4.15);
        context.lineTo(12.85, 14.2);
        context.lineTo(11.35, 14.2);
        halfEllipse(context, 8, 9.9, 3.35, 2.65, true);
        context.lineTo(4.65, 14.2);
        context.closePath();
        context.fill();

        roundRect(context, 0.5, 13.5, 15, 1.5, 0.75);
        context.fill();
    },

    snowflake(context) {
        for (let arm = 0; arm < 3; arm++) {
            context.save();
            context.translate(8, 8);
            context.rotate(arm * Math.PI / 3);
            line(context, 0, -6, 0, 6);
            for (const end of [-1, 1]) {
                line(context, 0, end * 3.75, -1.75, end * 5.25);
                line(context, 0, end * 3.75, 1.75, end * 5.25);
            }
            context.restore();
        }
    },

    camera(context) {
        roundRect(context, 1.75, 4.5, 9, 7, 2);
        context.stroke();
        context.moveTo(10.75, 7);
        context.lineTo(14.25, 5);
        context.lineTo(14.25, 11);
        context.lineTo(10.75, 9);
        context.stroke();
    },

    hub(context) {
        ring(context, 8, 8, 5.75);
        ring(context, 8, 8, 2.25);
    },

    home(context) {
        context.moveTo(1.75, 7.5);
        context.lineTo(8, 2.25);
        context.lineTo(14.25, 7.5);
        context.stroke();
        context.moveTo(3.75, 6);
        context.lineTo(3.75, 13.75);
        context.lineTo(12.25, 13.75);
        context.lineTo(12.25, 6);
        context.stroke();
        context.moveTo(6.75, 13.75);
        context.lineTo(6.75, 10.25);
        context.lineTo(9.25, 10.25);
        context.lineTo(9.25, 13.75);
        context.stroke();
    },

    search(context) {
        ring(context, 6.75, 6.75, 4.5);
        line(context, 10.25, 10.25, 14, 14);
    },

    aircon(context) {
        roundRect(context, 1.5, 2.75, 13, 6.5, 2);
        context.stroke();
        line(context, 4.5, 7, 11.5, 7);
        line(context, 5, 11.5, 4.25, 13.75);
        line(context, 8, 11.5, 8, 13.75);
        line(context, 11, 11.5, 11.75, 13.75);
    },

    sun(context) {
        ring(context, 8, 8, 2.75);
        for (let ray = 0; ray < 8; ray++) {
            const angle = ray * TAU / 8;
            line(context, 8 + 4.75 * Math.cos(angle), 8 + 4.75 * Math.sin(angle),
                8 + 6.25 * Math.cos(angle), 8 + 6.25 * Math.sin(angle));
        }
    },

    // Filled: an outlined crescent's two arcs don't meet cleanly at this size.
    moon(context) {
        context.save();
        context.newSubPath();
        context.arc(8, 8.25, 5.75, 0, TAU);
        context.clip();
        context.setFillRule(Cairo.FillRule.EVEN_ODD);
        context.rectangle(0, 0, 16, 16);
        context.newSubPath();
        context.arc(11.25, 5, 4.75, 0, TAU);
        context.fill();
        context.restore();
    },

    leaf(context) {
        context.moveTo(3, 13);
        context.curveTo(2.5, 6.5, 7, 2.75, 13.25, 2.75);
        context.curveTo(13.5, 9, 9.5, 13.5, 3, 13);
        context.closePath();
        context.stroke();
        line(context, 3, 13, 9.5, 6.5);
    },

    bolt(context) {
        context.moveTo(9.5, 1.75);
        context.lineTo(4, 9);
        context.lineTo(8, 9);
        context.lineTo(6.5, 14.25);
        context.lineTo(12, 7);
        context.lineTo(8, 7);
        context.closePath();
        context.stroke();
    },

    quiet(context) {
        context.moveTo(2.5, 6.25);
        context.lineTo(5, 6.25);
        context.lineTo(8.5, 3.25);
        context.lineTo(8.5, 12.75);
        context.lineTo(5, 9.75);
        context.lineTo(2.5, 9.75);
        context.closePath();
        context.stroke();
        context.newSubPath();
        context.arc(9.5, 8, 2.75, -0.8, 0.8);
        context.stroke();
    },

    tv(context) {
        roundRect(context, 1.75, 2.5, 12.5, 8.75, 1.5);
        context.stroke();
        line(context, 8, 11.25, 8, 13.5);
        line(context, 5, 13.75, 11, 13.75);
    },

    input(context) {
        context.moveTo(8.5, 2.25);
        context.lineTo(13.75, 2.25);
        context.lineTo(13.75, 13.75);
        context.lineTo(8.5, 13.75);
        context.stroke();
        line(context, 2, 8, 10.25, 8);
        arrowHead(context, 10.25, 8, 0);
    },

    apps(context) {
        for (const [left, top] of [[2, 2], [9, 2], [2, 9], [9, 9]])
            roundRect(context, left, top, 5, 5, 1.5);
        context.stroke();
    },

    remote(context) {
        roundRect(context, 4.75, 1.25, 6.5, 13.5, 2.25);
        context.stroke();
        ring(context, 8, 5.5, 1.75);
        dot(context, 8, 9.75, 0.9);
        dot(context, 8, 12, 0.9);
    },

    speaker(context) {
        context.moveTo(1.75, 6.25);
        context.lineTo(4.25, 6.25);
        context.lineTo(7.75, 3.25);
        context.lineTo(7.75, 12.75);
        context.lineTo(4.25, 9.75);
        context.lineTo(1.75, 9.75);
        context.closePath();
        context.stroke();
        for (const radius of [2.75, 5.5]) {
            context.newSubPath();
            context.arc(8.5, 8, radius, -0.8, 0.8);
            context.stroke();
        }
    },

    auto(context) {
        context.moveTo(4.5, 13);
        context.lineTo(8, 3);
        context.lineTo(11.5, 13);
        context.stroke();
        line(context, 5.75, 9.5, 10.25, 9.5);
    },

    wind(context) {
        context.moveTo(2, 6.5);
        context.lineTo(10.25, 6.5);
        context.arcNegative(10.25, 4.5, 2, TAU / 4, -TAU / 2);
        context.stroke();
        context.moveTo(2, 9.5);
        context.lineTo(12, 9.5);
        context.arc(12, 11.25, 1.75, -TAU / 4, TAU / 2);
        context.stroke();
        line(context, 2, 12.75, 6.5, 12.75);
    },
    plug(context) {
        context.arc(8, 8, 6, 0, TAU);
        context.stroke();
        for (const x of [5.6, 10.4]) {
            context.arc(x, 8, 1.1, 0, TAU);
            context.fill();
        }
    },
    rocker(context) {
        roundRect(context, 2.75, 2.75, 10.5, 10.5, 2.5);
        context.stroke();
        roundRect(context, 6, 5, 4, 6, 1);
        context.fill();
    },
    power(context) {
        context.arc(8, 8.75, 5.25, -TAU / 4 + 0.7, 3 * TAU / 4 - 0.7);
        context.stroke();
        line(context, 8, 2.25, 8, 7.5);
    },
    bell(context) {
        context.moveTo(4.25, 11.5);
        context.lineTo(4.25, 7.5);
        context.arc(8, 7.5, 3.75, TAU / 2, TAU);
        context.lineTo(11.75, 11.5);
        context.stroke();
        line(context, 2.75, 11.5, 13.25, 11.5);
        context.arc(8, 12.5, 1.5, 0, TAU / 2);
        context.stroke();
        line(context, 8, 2.25, 8, 3.75);
    },
    clock(context) {
        ring(context, 8, 8, 6);
        context.moveTo(8, 4.75);
        context.lineTo(8, 8);
        context.lineTo(10.5, 9.5);
        context.stroke();
    },
    timer(context) {
        ring(context, 8, 9, 5.5);
        line(context, 6.25, 1.75, 9.75, 1.75);
        line(context, 8, 1.75, 8, 3.5);
        line(context, 8, 9, 10.25, 6.75);
    },
};

function sweep(context, degrees) {
    const half = Math.min(degrees, 180) * Math.PI / 360;
    const [x, y, radius] = [8, 12, 7];
    context.moveTo(x, y);
    context.arc(x, y, radius, -TAU / 4 - half, -TAU / 4 + half);
    context.closePath();
    context.stroke();
    dot(context, x, y, 1.25);
}
GLYPHS.angle = context => sweep(context, 120);

function arrowHead(context, x, y, direction) {
    for (const side of [-1, 1]) {
        const back = direction + Math.PI + side * 0.6;
        line(context, x, y, x + 2.6 * Math.cos(back), y + 2.6 * Math.sin(back));
    }
}

// Draws at a third of the colour: the range a louver can take, behind where it points.
function faint(context, sketch) {
    const ink = context.getSource();
    context.pushGroup();
    sketch();
    context.popGroupToSource();
    context.paintWithAlpha(0.35);
    context.setSource(ink);
}

// Louver positions as arrows over their range: 1 to 5, then the range as a two-headed
// arc for swing; 0 is the range alone. Vertical seen from the side, top to bottom;
// horizontal from above, left to right.
const LOUVERS = {
    flow: {
        unit: context => roundRect(context, 1.5, 1.5, 7.5, 4, 1.25),
        x: 6.5, y: 6.75, radius: 7.75, from: 0, to: Math.PI / 2,
    },
    side: {
        unit: context => roundRect(context, 2.5, 1.5, 11, 3, 1.25),
        x: 8, y: 5.75, radius: 8, from: Math.PI / 2 + 0.96, to: Math.PI / 2 - 0.96,
    },
};

function louverGlyph(context, {unit, x, y, radius, from, to}, position) {
    unit(context);
    context.stroke();
    const [low, high] = from < to ? [from, to] : [to, from];
    const range = () => {
        context.newSubPath();
        context.arc(x, y, radius, low, high);
        context.stroke();
    };
    if (position === 'swing') {
        range();
        const turn = from < to ? Math.PI / 2 : -Math.PI / 2;
        arrowHead(context, x + radius * Math.cos(from), y + radius * Math.sin(from), from - turn);
        arrowHead(context, x + radius * Math.cos(to), y + radius * Math.sin(to), to + turn);
        return;
    }
    faint(context, range);
    if (position === 0)
        return;
    const angle = from + (to - from) * (position - 1) / 4;
    const tipX = x + radius * Math.cos(angle);
    const tipY = y + radius * Math.sin(angle);
    line(context, x, y, tipX, tipY);
    arrowHead(context, tipX, tipY, angle);
}

for (const [name, louver] of Object.entries(LOUVERS)) {
    GLYPHS[`${name}-swing`] = context => louverGlyph(context, louver, 'swing');
    for (let position = 0; position <= 5; position++)
        GLYPHS[`${name}${position}`] = context => louverGlyph(context, louver, position);
}

// Fan speed 1 to 5 as rising bars, the ones above it faint.
function bars(context, from, to) {
    for (let i = from; i < to; i++) {
        const height = 3 + i * 2.5;
        roundRect(context, 1.5 + i * 2.75, 14 - height, 2, height, 0.75);
    }
    context.fill();
}

for (let speed = 1; speed <= 5; speed++) {
    GLYPHS[`speed${speed}`] = context => {
        faint(context, () => bars(context, speed, 5));
        bars(context, 0, speed);
    };
}

/** Expects the context already scaled to the 16x16 grid, with its colour set. */
export function draw(context, name) {
    context.setLineWidth(1.5);
    context.setLineCap(Cairo.LineCap.ROUND);
    context.setLineJoin(Cairo.LineJoin.ROUND);
    const degrees = /^angle(\d+)$/.exec(name)?.[1];
    if (degrees)
        sweep(context, Number(degrees));
    else
        (GLYPHS[name] ?? GLYPHS.appliance)(context);
}

const KINDS = {
    'fan': ['fan', [0.2, 0.68, 0.85]],
    'light': ['bulb', [0.96, 0.76, 0.26]],
    'temperature-humidity-sensor': ['thermometer', [0.95, 0.47, 0.35]],
    'motion-sensor': ['motion', [0.36, 0.78, 0.5]],
    'magnet-sensor': ['door', [0.36, 0.78, 0.5]],
    'vacuum': ['vacuum', [0.6, 0.47, 0.9]],
    'submersion-sensor': ['drop', [0.3, 0.6, 0.95]],
    'scale': ['scale', [0.62, 0.62, 0.68]],
    'remote-control': ['button', [0.62, 0.62, 0.68]],
    'smoke-sensor': ['smoke', [0.9, 0.35, 0.35]],
    'repeater': ['wifi', [0.62, 0.62, 0.68]],
    'gateway': ['hub', [0.62, 0.62, 0.68]],
    'air-fryer': ['pot', [0.93, 0.55, 0.3]],
    'kettle': ['kettle', [0.93, 0.55, 0.3]],
    'scooter': ['scooter', [0.62, 0.62, 0.68]],
    'air-conditioner': ['aircon', [0.3, 0.6, 0.95]],
    'camera': ['camera', [0.62, 0.62, 0.68]],
    'speaker': ['speaker', [0.66, 0.46, 0.95]],
    'television': ['tv', [0.4, 0.52, 0.98]],
    'outlet': ['plug', [0.32, 0.74, 0.58]],
    'switch': ['rocker', [0.32, 0.74, 0.58]],
    'washer': ['washer', [0.35, 0.6, 0.95]],
    'dishwasher': ['dishwasher', [0.2, 0.66, 0.78]],
    'air-purifier': ['purifier', [0.3, 0.76, 0.62]],
    'humidifier': ['humidifier', [0.3, 0.7, 0.95]],
    'dehumidifier': ['dehumidifier', [0.45, 0.56, 0.95]],
    'heater': ['heater', [0.95, 0.45, 0.3]],
    'curtain': ['curtain', [0.66, 0.55, 0.9]],
    'lock': ['lock', [0.62, 0.62, 0.68]],
    'fridge': ['fridge', [0.45, 0.72, 0.95]],
    'coffee-machine': ['coffee', [0.72, 0.5, 0.34]],
    'thermostat': ['thermostat', [0.95, 0.55, 0.3]],
    'doorbell': ['doorbell', [0.62, 0.62, 0.68]],
    'plant-monitor': ['plant', [0.36, 0.76, 0.4]],
    'cooker': ['cooker', [0.93, 0.55, 0.3]],
    'water-purifier': ['filter', [0.3, 0.65, 0.95]],
};

const SAME_AS = {
    'occupancy-sensor': 'motion-sensor',
    'gas-sensor': 'smoke-sensor',
    'air-monitor': 'temperature-humidity-sensor',
    'router': 'repeater',
    'health-pot': 'kettle',
    'ceiling-fan': 'fan',
    'plug': 'outlet',
    'dryer': 'washer',
    'air-fresh': 'air-purifier',
    'video-doorbell': 'doorbell',
    'pressure-cooker': 'cooker',
    'window-opener': 'curtain',
};

const SOURCES = {gree: 'air-conditioner', midea: 'air-conditioner', daikin: 'air-conditioner', cast: 'speaker',
    tapo: 'camera', tv: 'television', sonoff: 'switch'};

const MODEL_HINTS = [
    [/aircondition|acpartner/, 'air-conditioner'],
    [/sensor_ht|weather|airmonitor/, 'temperature-humidity-sensor'],
    [/magnet/, 'magnet-sensor'],
    [/motion/, 'motion-sensor'],
    [/wleak|flood/, 'submersion-sensor'],
    [/smoke|natgas/, 'smoke-sensor'],
    [/sensor_switch|remote/, 'remote-control'],
    [/wifispeaker/, 'speaker'],
    [/camera/, 'camera'],
    [/plug|outlet/, 'outlet'],
    [/gateway/, 'gateway'],
    [/repeater/, 'repeater'],
    [/fryer/, 'air-fryer'],
    [/dishwasher/, 'dishwasher'],
    [/washer|dryer/, 'washer'],
    [/airpurifier|\.airp\.|airfresh/, 'air-purifier'],
    [/dehumidifier|derh/, 'dehumidifier'],
    [/humidifier/, 'humidifier'],
    [/heater/, 'heater'],
    [/curtain|blind/, 'curtain'],
    [/\.lock\./, 'lock'],
    [/fridge/, 'fridge'],
    [/coffee/, 'coffee-machine'],
    [/thermostat/, 'thermostat'],
    [/doorbell|cateye/, 'doorbell'],
    [/flowerpot|plantmon|hhcc/, 'plant-monitor'],
    [/cooker/, 'cooker'],
    [/waterpuri/, 'water-purifier'],
    [/kettle/, 'kettle'],
    [/vacuum/, 'vacuum'],
    [/fan/, 'fan'],
    [/light|lamp|bulb/, 'light'],
    [/scale/, 'scale'],
    [/scooter/, 'scooter'],
];

const APPLIANCE = ['appliance', [0.93, 0.55, 0.3]];

const PROPERTY_KINDS = {
    'guard-mode': ['shield', [0.36, 0.78, 0.5]],
    'physical-controls-locked': ['lock', [0.62, 0.62, 0.68]],
    'horizontal-swing': ['swing', [0.2, 0.68, 0.85]],
    'vertical-swing': ['swing', [0.2, 0.68, 0.85]],
};

export function kindOf(type, switchedService = null, model = '') {
    if (switchedService === 'light')
        return KINDS.light;
    return KINDS[kindName(type, model)] ?? APPLIANCE;
}

export function kindName(type, model = '') {
    const same = SAME_AS[type] ?? type;
    if (KINDS[same])
        return same;
    const text = model ?? '';
    return SOURCES[text.split(' ')[0]] ?? MODEL_HINTS.find(([pattern]) => pattern.test(text))?.[1] ?? null;
}

export function kindOfProperty(name, type, model = '') {
    if (name === 'on')
        return kindOf(type, null, model);
    return PROPERTY_KINDS[name] ?? (name.includes('light') ? KINDS.light : kindOf(type, null, model));
}

const LOOKS = new Map(Object.values({...PROPERTY_KINDS, ...KINDS}).map(([name, color]) => [name, color]));

export const CHOICES = [
    ...new Set([...Object.values(KINDS), ...Object.values(PROPERTY_KINDS)].map(([name]) => name)),
    'appliance', 'power', 'home', 'bolt', 'bell', 'clock', 'sun', 'moon', 'leaf', 'snowflake', 'wind',
];

/** The colour a chosen glyph carries, or the given one for glyphs no device type has. */
export function colorOf(name, fallback) {
    return LOOKS.get(name) ?? fallback;
}
