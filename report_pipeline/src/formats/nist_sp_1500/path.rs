use std::path::{Path, PathBuf};

/// Represents the resolved source of CVR data
#[derive(Debug, PartialEq)]
pub enum CvrSource {
    /// CVR data is in a directory
    Directory(PathBuf),
    /// CVR data is in a ZIP file
    Zip(PathBuf),
    /// CVR source could not be found
    NotFound,
}

/// Resolves the CVR path from a base path and CVR name parameter.
///
/// Handles several edge cases:
/// - "." as CVR name means use the base path directly
/// - If path ends with .zip but file doesn't exist, tries directory without .zip extension
/// - Falls back to base path if CVR path doesn't exist but base has manifest files
pub fn resolve_cvr_path(base_path: &Path, cvr_name: &str) -> PathBuf {
    // Handle "." as current directory
    let mut cvr_path = if cvr_name == "." {
        base_path.to_path_buf()
    } else {
        base_path.join(cvr_name)
    };

    // If the path ends with .zip but the file doesn't exist, try the directory name without .zip
    // This handles cases where ZIP files were extracted but metadata still references the ZIP
    if cvr_path.to_string_lossy().ends_with(".zip") && !cvr_path.exists() {
        let dir_path = cvr_path.with_extension("");
        if dir_path.is_dir() {
            cvr_path = dir_path;
        }
    }

    // If the CVR path doesn't exist, try using the base path directly
    // This handles cases where metadata references a CVR name but files are in the base directory
    if !cvr_path.exists() && !cvr_path.is_dir() {
        // Check if the base path itself is a directory with CvrExport files
        if base_path.is_dir() {
            let test_file = base_path.join("CvrExport.json");
            if test_file.exists() || base_path.join("CandidateManifest.json").exists() {
                // Files are in the base directory, use that instead
                cvr_path = base_path.to_path_buf();
            }
        }
    }

    cvr_path
}

/// Detects the type of CVR source at the given path
pub fn detect_cvr_source(cvr_path: &Path) -> CvrSource {
    if cvr_path.is_dir() {
        CvrSource::Directory(cvr_path.to_path_buf())
    } else if cvr_path.exists() {
        CvrSource::Zip(cvr_path.to_path_buf())
    } else {
        CvrSource::NotFound
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{self, File};
    use tempfile::TempDir;

    #[test]
    fn test_resolve_cvr_path_dot_returns_base() {
        let temp_dir = TempDir::new().unwrap();
        let base_path = temp_dir.path();

        let result = resolve_cvr_path(base_path, ".");
        assert_eq!(result, base_path);
    }

    #[test]
    fn test_resolve_cvr_path_joins_cvr_name() {
        let temp_dir = TempDir::new().unwrap();
        let base_path = temp_dir.path();
        let cvr_dir = base_path.join("my_cvr");
        fs::create_dir(&cvr_dir).unwrap();

        let result = resolve_cvr_path(base_path, "my_cvr");
        assert_eq!(result, cvr_dir);
    }

    #[test]
    fn test_resolve_cvr_path_zip_fallback_to_directory() {
        let temp_dir = TempDir::new().unwrap();
        let base_path = temp_dir.path();

        // Create a directory named "cvr" (simulating extracted ZIP)
        let cvr_dir = base_path.join("cvr");
        fs::create_dir(&cvr_dir).unwrap();

        // Request "cvr.zip" which doesn't exist, should fall back to "cvr" directory
        let result = resolve_cvr_path(base_path, "cvr.zip");
        assert_eq!(result, cvr_dir);
    }

    #[test]
    fn test_resolve_cvr_path_fallback_to_base_with_manifest() {
        let temp_dir = TempDir::new().unwrap();
        let base_path = temp_dir.path();

        // Create CandidateManifest.json in base directory
        File::create(base_path.join("CandidateManifest.json")).unwrap();

        // Request a CVR path that doesn't exist
        let result = resolve_cvr_path(base_path, "nonexistent_cvr");

        // Should fall back to base path since it has manifest files
        assert_eq!(result, base_path);
    }

    #[test]
    fn test_resolve_cvr_path_fallback_to_base_with_cvr_export() {
        let temp_dir = TempDir::new().unwrap();
        let base_path = temp_dir.path();

        // Create CvrExport.json in base directory
        File::create(base_path.join("CvrExport.json")).unwrap();

        // Request a CVR path that doesn't exist
        let result = resolve_cvr_path(base_path, "nonexistent_cvr");

        // Should fall back to base path since it has CVR files
        assert_eq!(result, base_path);
    }

    #[test]
    fn test_resolve_cvr_path_no_fallback_without_manifest() {
        let temp_dir = TempDir::new().unwrap();
        let base_path = temp_dir.path();

        // Don't create any manifest files
        let result = resolve_cvr_path(base_path, "nonexistent_cvr");

        // Should return the requested path even though it doesn't exist
        assert_eq!(result, base_path.join("nonexistent_cvr"));
    }

    #[test]
    fn test_detect_cvr_source_directory() {
        let temp_dir = TempDir::new().unwrap();
        let dir_path = temp_dir.path();

        let result = detect_cvr_source(dir_path);
        assert_eq!(result, CvrSource::Directory(dir_path.to_path_buf()));
    }

    #[test]
    fn test_detect_cvr_source_zip_file() {
        let temp_dir = TempDir::new().unwrap();
        let zip_path = temp_dir.path().join("test.zip");
        File::create(&zip_path).unwrap();

        let result = detect_cvr_source(&zip_path);
        assert_eq!(result, CvrSource::Zip(zip_path));
    }

    #[test]
    fn test_detect_cvr_source_not_found() {
        let result = detect_cvr_source(Path::new("/nonexistent/path"));
        assert_eq!(result, CvrSource::NotFound);
    }
}
