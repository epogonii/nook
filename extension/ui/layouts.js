// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';

// Wraps children at their natural widths. Clutter.FlowLayout uses equal-width columns,
// which leave gaps around short room names.
export const WrapLayout = GObject.registerClass(
class WrapLayout extends Clutter.LayoutManager {
    _init(spacing) {
        super._init();
        this._spacing = spacing;
    }

    _lines(container, width) {
        const lines = [];
        let line = null;
        for (const child of container.get_children()) {
            if (!child.visible)
                continue;
            const [, childWidth] = child.get_preferred_width(-1);
            const [, childHeight] = child.get_preferred_height(childWidth);
            const w = Math.min(childWidth, width);
            if (!line || line.width + this._spacing + w > width) {
                line = {width: 0, height: 0, items: []};
                lines.push(line);
            } else {
                line.width += this._spacing;
            }
            line.items.push([child, w, childHeight]);
            line.width += w;
            line.height = Math.max(line.height, childHeight);
        }
        return lines;
    }

    vfunc_get_preferred_width(container, _forHeight) {
        let min = 0, natural = 0;
        for (const child of container.get_children()) {
            if (!child.visible)
                continue;
            const [, childWidth] = child.get_preferred_width(-1);
            min = Math.max(min, childWidth);
            natural += childWidth + this._spacing;
        }
        return [min, Math.max(0, natural - this._spacing)];
    }

    vfunc_get_preferred_height(container, forWidth) {
        const lines = this._lines(container, forWidth < 0 ? Infinity : forWidth);
        const height = lines.reduce((sum, l) => sum + l.height + this._spacing, 0);
        return [Math.max(0, height - this._spacing), Math.max(0, height - this._spacing)];
    }

    vfunc_allocate(container, box) {
        let y = box.y1;
        for (const line of this._lines(container, box.get_width())) {
            let x = box.x1;
            for (const [child, w, h] of line.items) {
                child.allocate(new Clutter.ActorBox({x1: x, y1: y, x2: x + w, y2: y + h}));
                x += w + this._spacing;
            }
            y += line.height + this._spacing;
        }
    }
});

// Rows of equal cells, filled left to right as the drop markers (left, right) assume. A lone
// child spans the row; hidden children leave no gap.
export const ColumnsLayout = GObject.registerClass(
class ColumnsLayout extends Clutter.LayoutManager {
    _init(columns, spacing) {
        super._init();
        this._columns = columns;
        this._spacing = spacing;
    }

    // Visible children by row, and the number of columns they fill.
    _grid(container) {
        const children = container.get_children().filter(child => child.visible);
        const rows = [];
        for (let i = 0; i < children.length; i += this._columns)
            rows.push(children.slice(i, i + this._columns));
        return [rows, Math.max(1, Math.min(children.length, this._columns))];
    }

    _cellWidth(columns, width) {
        return (width - this._spacing * (columns - 1)) / columns;
    }

    _heights(rows, width) {
        return rows.map(row => Math.max(...row.map(child => child.get_preferred_height(width)[1])));
    }

    vfunc_get_preferred_width(container, _forHeight) {
        const [rows, columns] = this._grid(container);
        let min = 0, natural = 0;
        for (const child of rows.flat()) {
            const [childMin, childNatural] = child.get_preferred_width(-1);
            min = Math.max(min, childMin);
            natural = Math.max(natural, childNatural);
        }
        const gaps = this._spacing * (columns - 1);
        return [min * columns + gaps, natural * columns + gaps];
    }

    vfunc_get_preferred_height(container, forWidth) {
        const [rows, columns] = this._grid(container);
        const width = forWidth < 0 ? -1 : this._cellWidth(columns, forWidth);
        const height = this._heights(rows, width).reduce((sum, h) => sum + h + this._spacing, 0);
        return [Math.max(0, height - this._spacing), Math.max(0, height - this._spacing)];
    }

    vfunc_allocate(container, box) {
        const [rows, columns] = this._grid(container);
        const width = this._cellWidth(columns, box.get_width());
        const heights = this._heights(rows, width);
        let y = box.y1;
        rows.forEach((row, i) => {
            row.forEach((child, j) => {
                const x = box.x1 + j * (width + this._spacing);
                child.allocate(new Clutter.ActorBox({x1: x, y1: y, x2: x + width, y2: y + heights[i]}));
            });
            y += heights[i] + this._spacing;
        });
    }
});
