// RUSTC_VERSION="$(rustc --version)" rustc -O main.rs -o fmt && ./fmt > table.tsv
// Columns: type, input literal (parsed by Rust `str::parse`, which rounds like JS `Number`), precision, format!("{:.N}").
fn main() {
    println!("# {}", option_env!("RUSTC_VERSION").unwrap_or("rustc version unknown"));
    let values = ["0.125", "0.375", "-0.125", "-0.375", "0.5", "1.5", "2.5", "-2.5", "3.5", "0.25", "0.75", "2.675", "1.005", "1.045", "0.045", "0.135",
        "-0.0", "0.0", "-1e-7", "1e-7", "-0.04", "123456789.125", "9007199254740993", "1e21", "1e22", "-1e21", "1.7976931348623157e308", "5e-324",
        "0.1", "0.3", "99.995", "999.9999", "-999.9999", "1e-5", "42", "NaN", "inf", "-inf", "0.0625", "0.1875", "1234.5", "1235.5"];
    let precisions = [0usize, 1, 2, 3, 20];
    for v in values {
        let x: f64 = v.parse().unwrap();
        for &p in &precisions {
            println!("f64\t{}\t{}\t{:.*}", v, p, p, x);
        }
    }
    for v in ["0.1", "0.125", "-2.5", "3.4028235e38", "1e-45", "16777217", "0.3"] {
        let x: f32 = v.parse().unwrap();
        for &p in &[0usize, 2, 10] {
            println!("f32\t{}\t{}\t{:.*}", v, p, p, x);
        }
    }
}
