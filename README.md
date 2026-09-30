# Bases Kanban Card Colors

Color the cards in Obsidian's built-in **Bases Kanban view** by due date or by any property, and show how long until each task is due.

<!-- Add a screenshot here: ![Kanban board with colored cards](screenshot.png) -->

## Features

- **Due-date colors.** Cards turn red when overdue, orange when due today, and yellow when due soon (you choose how many days counts as "soon"). Each color can be changed or turned off.
- **Due badge.** A small label in each card's bottom-right corner: "Due: 8 days", "Due: Tomorrow", "Due: Today", "Overdue: 3 days".
- **Rules by property.** Color cards by any property, for example `Rating is 5` → green, `Read is unread` → blue, `Owner is Kate` → purple. Rules are checked top to bottom and the first match wins.
- **Card filter.** Limit which cards can be colored, for example only tasks whose Status is To-Do, In Progress or With Client, so finished work stays plain.
- **Per-base control.** Apply due-date colors or individual rules only to specific bases.
- **Highlight styles.** Tint, border only, or a left stripe, with an adjustable tint strength.
- **Quick toggle.** A command, "Turn card coloring on or off", that you can bind to a hotkey.

## Requirements

- Obsidian 1.14 or later (the version that added the Kanban view to Bases).
- The card title (file name) must be visible on the cards. The plugin uses it to match each card to its note.

## Settings

### Rules by due date
| Setting | What it does |
|---|---|
| Date properties | The date properties to check. With more than one, the earliest date sets the color. |
| Use on these bases | Bases that get due-date colors. Leave empty for all bases. |
| Overdue / Due today / Due soon | Turn each state on or off and choose its color. "Due soon" covers the next X days (0 = any future date). |
| Show due badge | Shows "Due: X days", "Due: Today" or "Overdue: X days" in each card's corner. |

### Rules by property
Each rule reads like a sentence: **When** [property] [condition] [value] → color.

- Conditions: is, is not, is any of, contains, is greater than, is less than, is empty, is not empty.
- Numbers and dates compare as numbers and dates; text comparisons ignore capitalization and emoji.
- **Follow the card filter**: when checked, the rule only colors cards that pass the card filter.
- **In**: limit the rule to specific bases. Empty means all bases.
- **When a card matches both a due-date rule and a property rule**: choose whether the due date or the property rule wins.

### Which cards can be colored (card filter)
Turn the filter on, choose whether cards must match **all** or **any** of the conditions, and add conditions using the same builder as property rules. Due-date colors always follow the filter.

### Appearance
- **Color cards**: master on/off switch.
- **Highlight style**: Tint, Border only, or Left stripe.
- **Highlight strength**: how strong the tint is.

## Installation

### From the community plugin list
Settings → Community plugins → Browse → search for "Bases Kanban Card Colors".

### Manually
1. Download `main.js`, `manifest.json` and `styles.css` from the latest release.
2. Put them in `<your vault>/.obsidian/plugins/bases-kanban-card-colors/`.
3. Reload Obsidian and enable **Bases Kanban Card Colors** under Settings → Community plugins.

## Notes and limitations

- Obsidian doesn't yet offer an official way for plugins to style built-in Kanban cards, so this plugin works with the cards as Obsidian draws them. A future Obsidian update could change that; if colors stop appearing after an update, please open an issue.
- Cards whose notes share a file name with another note are matched to the note that has the properties your rules use.
- Colors update automatically at midnight.

## License

[MIT](LICENSE)
