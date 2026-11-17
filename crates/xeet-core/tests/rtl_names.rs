//! Account names written right to left.
//!
//! X's name, handle and credit boxes carry no `dir` attribute, so they take the
//! page's `ltr` (the logged-in client even sets `dir="ltr"` on the name). An
//! Arabic or Hebrew name is a right-to-left run inside a left-to-right line: it
//! starts at its box's left edge and the badge follows it.

use xeet_core::display::Item;
use xeet_core::limits;
use xeet_core::model::{Post, RenderOptions, Surface, Theme};
use xeet_core::render;

const NAMES: &[&str] = &["المنتخب السعودي", "שלום עולם"];

const SURFACES: &[Surface] = &[
    Surface::WebTimeline,
    Surface::WebDetail,
    Surface::IosTimeline,
    Surface::IosDetail,
];

struct Run {
    start: f32,
    end: f32,
    baseline: f32,
}

/// Each glyph run's first and last glyph origin, and the badge icons.
fn draw(post: &Post, surface: Surface) -> (Vec<Run>, Vec<(f32, f32)>) {
    let opts = RenderOptions {
        surface,
        width: 390.0,
        theme: Theme::Dark,
        ..RenderOptions::default()
    };
    let (list, _) = render::display_list(post, &opts).expect("renders");
    let mut runs = Vec::new();
    let mut badges = Vec::new();
    for item in &list.items {
        match item {
            Item::Glyphs { x, y, glyphs, .. } if !glyphs.is_empty() => {
                let xs = glyphs.iter().map(|g| x + g.x);
                runs.push(Run {
                    start: xs.clone().fold(f32::INFINITY, f32::min),
                    end: xs.fold(f32::NEG_INFINITY, f32::max),
                    baseline: *y,
                });
            }
            Item::Icon { name, rect, .. } if name.starts_with("icon-verified") => {
                badges.push((rect.x, rect.y + rect.h / 2.0));
            }
            _ => {}
        }
    }
    (runs, badges)
}

/// Asserts the name is drawn on the badge's row, inside the canvas, ending
/// before the badge.
fn assert_name_before_badge(runs: &[Run], badge: (f32, f32), what: &str) {
    for run in runs {
        assert!(
            run.start >= 0.0 && run.end <= 390.0,
            "{what}: a glyph run is drawn outside the canvas, at {}..{}",
            run.start,
            run.end
        );
    }
    let (badge_x, badge_mid) = badge;
    let name = runs
        .iter()
        .find(|r| (r.baseline - badge_mid).abs() < 12.0 && r.end < badge_x);
    assert!(
        name.is_some(),
        "{what}: no glyphs before the badge at x {badge_x} on its row"
    );
}

#[test]
fn a_right_to_left_name_is_drawn_before_its_badge() {
    for name in NAMES {
        let post = limits::parse_post(&format!(
            r#"{{"text":"hi","author":{{"name":"{name}","handle":"saudint","verified":"business"}}}}"#
        ))
        .unwrap();
        for &surface in SURFACES {
            let (runs, badges) = draw(&post, surface);
            let what = format!("{name} on {surface:?}");
            assert_eq!(badges.len(), 1, "{what}: one badge");
            assert_name_before_badge(&runs, badges[0], &what);
        }
    }
}

#[test]
fn a_quoted_right_to_left_name_is_drawn_before_its_badge() {
    for name in NAMES {
        let post = limits::parse_post(&format!(
            r#"{{"text":"What a season.","author":{{"name":"Emaar","handle":"emaar"}},
                "quote":{{"text":"hi","author":{{"name":"{name}","handle":"alhilal","verified":"business"}}}}}}"#
        ))
        .unwrap();
        for &surface in &[Surface::WebTimeline, Surface::WebDetail] {
            let (runs, badges) = draw(&post, surface);
            let what = format!("quoted {name} on {surface:?}");
            assert_eq!(badges.len(), 1, "{what}: one badge, the quote's");
            assert_name_before_badge(&runs, badges[0], &what);
        }
    }
}
